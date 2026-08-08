# 平台补强 + outline-designer 模板 - 开发规划（Dev Plan）

> 状态：**草案（Draft）**，对齐 `docs/2026-08-07-platform-enhancements-spec.md` 与上游设计 `docs/2026-08-07-outline-designer-template-plan.md`。
> 实施谱系：**远端 standalone**（`/Users/lzy/Desktop/ForgeCore`），9 动作 + 产物版本目录制 + live update。
> 实施者：远端 Claude Code agent。每 Phase 结束跑验收门禁；实施前 `git -C /Users/lzy/Desktop/ForgeCore status` 确认工作区干净。

---

## 总体策略

- **TDD**：先写测试（vitest），后改实现。每 Phase 的测试必须先红后绿。
- **依赖图**：

```
Phase 1 (skill 渐进式披露) ─┐
Phase 2 (门禁执行环境) ──────┼─> Phase 4 (outline-designer 模板) ─> Phase 5 (集成验证)
Phase 3 (回合内压缩) ────────┘
```

- Phase 1 / 2 / 3 互相独立，可并行（或按序）。Phase 4 依赖 1+2（模板用 sectionsPath + gate）。Phase 5 依赖全部。
- **每 Phase 验收门禁**：`cd /Users/lzy/Desktop/ForgeCore && npm run check && npx vitest run <相关测试> && npm run build`。全绿才进下一 Phase。
- 远端跑前先 `npm install`（node_modules 可能缺失）；Phase 2 需 `npm install isolated-vm`。
- 实施时以**远端实际代码**为准（远端 9 动作版，比本地 GitHub 谱系 6 动作版多 annotate/forward/read_artifact_version + 产物版本目录）。spec 给的符号若与远端不符，以远端为准并记录偏差。

---

## Phase 1 — skill 渐进式披露

**目标**：skill 从单文件扩展为「主入口 + sections 子目录」；`load_skill` 只回主入口，新增只读工具 `read_skill_section` 按需读子文件。

### 文件改动表

| 文件 | 改动 |
| --- | --- |
| `src/server/template/template-schema.ts` | `FrozenSkill` 增 `sectionsPath: string\|null`、`sections: string[]`。 |
| `src/server/template/template-loader.ts` | `readSkillContent` 流程：若 `sectionsPath` 非空，遍历该目录收集 `.md` 相对路径入 `sections`；非 .md/隐藏/符号链接跳过；containment + realpath 校验；`computeVersionHash` 纳入每个 section 内容。 |
| `src/server/runtime/skill-service.ts` | 新增 `readSection(taskId, agentId, skillId, sectionPath)`：校验 `sectionPath ∈ skill.sections`，从 snapshot 读，返回 `{content, versionHash}`，只读不写事件。新增错误码 `SKILL_SECTION_NOT_AUTHORIZED` / `SKILL_SECTION_MISSING` / `SKILL_SECTION_PATH_UNSAFE`。 |
| `src/server/runtime/skill-service-errors.ts`（或既有错误码文件） | 注册 3 个新 section 错误码（对照远端 `SKILL_ERROR_CODES` 既有结构）。 |
| `src/server/runtime/pi-tool-factory.ts` | 新增 `createSkillSectionToolDefinitions({ skills, taskId, agentId })` 工厂，工具 `read_skill_section(skillId, sectionPath)`，只读，不进 ActionBuffer。 |
| `src/server/runtime/pi-agent-runtime.ts` | `customTools` 数组加入 skill-section 工具定义（与 workspace 工具并列）。 |

### 测试

- `template-loader.test.ts`：声明 `sectionsPath` 的模板 -> `sections` 收集正确（含子目录文件、跳过非 .md）；`sectionsPath` 为 null -> `sections` 为空、行为不变。
- `template-loader.test.ts`：改 section 内容 -> `versionHash` 变；改 `sectionsPath` 目录外文件 -> hash 不变。
- `skill-service.test.ts`：`readSection` 授权（非 `sections` 内 -> `SKILL_SECTION_NOT_AUTHORIZED`）、containment（逃逸 -> `SKILL_SECTION_PATH_UNSAFE`）、缺失（`SKILL_SECTION_MISSING`）、正常返回 content。
- `pi-tool-factory.test.ts`：`read_skill_section` 工具回调返回 content；只读不进 buffer（调用后 `ActionBuffer.actions` 为空）。
- 向后兼容：现有 `zhihu-single-chapter` / `long-form-hub` 模板（`sectionsPath` 未声明）加载与 `versionHash` 不变。

### 依赖

无。可与 Phase 2 / 3 并行。

### 验收门禁

`npm run check && npx vitest run template-loader skill-service pi-tool-factory && npm run build` 全绿。

---

## Phase 2 — 门禁执行环境（JS 校验器）

**目标**：模板可声明 JS 校验器；平台在 isolated-vm（或 QuickJS fallback）沙箱执行；模型可调 `validate_artifact` 自检，提交时 `action-committer` 兜底门禁。

### 前置

```bash
cd /Users/lzy/Desktop/ForgeCore
npm install isolated-vm
# 在 macOS arm64 上验证编译通过；失败则 npm uninstall isolated-vm && npm install quickjs-emscripten，改用 QuickJS 适配
```

### 文件改动表

| 文件 | 改动 |
| --- | --- |
| `src/server/template/template-schema.ts` | `FrozenAgentConfig` 增 `gate: FrozenGate\|null`（`{validator, artifactType, mode: Array<'self_check'\|'commit'>}`）。 |
| `src/server/template/template-loader.ts` | 读 `gate.validator` 文件入 snapshot（containment + realpath），纳入 `versionHash`。 |
| `src/server/runtime/gate-runner.ts`（**新文件**） | `GateRunner` 类：isolate 内编译 validator 默认导出 `validate`；`run(taskId, agentId, content, artifactType) -> {pass, issues}`；沙箱限制（无 FS/网络/require、CPU 5s、内存 64MB）；per-task-isolate 缓存（key `taskId:agentId:validatorHash`）；契约校验（返回值不合规 -> `GATE_CONTRACT_INVALID`）。模块零业务词。 |
| `src/server/runtime/gate-errors.ts`（或既有错误码文件） | 注册 `GATE_COMPILE_FAILED` / `GATE_TIMEOUT` / `GATE_RUNTIME_ERROR` / `GATE_CONTRACT_INVALID` / `GATE_REJECTED`。 |
| `src/server/runtime/action-committer.ts` | `COMMIT_ERROR_CODES` 增 `GATE_REJECTED`；`ActionCommitterOptions` 增 `gateRunner` 依赖；在 `sealPackage` 确定后、任何写操作前：若 `currentAgent.gate?.mode` 含 `'commit'` 且 dispatch 会落盘产物（`publish_artifact` 或 `submit_final_artifact` 且 `source !== 'current_input_artifact'`），跑校验器；`pass === false` 或运行时错误 -> `CommitFailure(GATE_REJECTED / GATE_RUNTIME_ERROR, ...)`，不写事件。 |
| `src/server/runtime/pi-tool-factory.ts` | 新增 `createValidateArtifactToolDefinitions({ gateRunner, workspaces, agent, taskId, agentId })`，工具 `validate_artifact(source, workspaceFile?, content?, artifactType?)`，仅当 `agent.gate` 且含 `self_check` 时返回工具，否则空数组；只读不进 buffer。 |
| `src/server/runtime/pi-agent-runtime.ts` | `customTools` 加入 validate-artifact 工具（条件注册）；构造 `GateRunner` 注入 committer 与工具工厂。 |
| `src/server/runtime/task-runner.ts` | 构造 `ActionCommitter` 时传入 `gateRunner`（如尚未注入）。 |

### 测试

- `gate-runner.test.ts`：跑合法 validator（pass/reject 各路径）；沙箱限制（`require('fs')` 被挡、`fetch` 被挡）；超时（死循环 -> `GATE_TIMEOUT`）；契约不合规（返回 `{}` -> `GATE_CONTRACT_INVALID`）；编译错误（语法错 -> `GATE_COMPILE_FAILED`）。
- `action-committer.test.ts`：`gate.mode=[commit]` + 校验不过 -> 抛 `GATE_REJECTED`，无产物事件写入（`EventStore` 断言为空）；校验过 -> 正常提交；`gate.mode=[self_check]`（无 commit）-> 不兜底，正常提交；运行时错误 -> `GATE_RUNTIME_ERROR`，不写盘。
- `pi-tool-factory.test.ts`：`validate_artifact` 工具回调返回 `{pass, issues}`；只读不进 buffer；`agent.gate` 为 null 时不注册该工具。
- 铁律断言：`gate-runner.ts` 与 `action-committer.ts` 源码不含 `blueprint`/`大纲`/`章节` 等业务词（grep 检查，仅允许在测试 fixture 与模板 `gates/` 下出现）。

### 依赖

无。可与 Phase 1 / 3 并行。

### 验收门禁

`npm run check && npx vitest run gate-runner action-committer pi-tool-factory && npm run build` 全绿；isolated-vm 在远端 arm64 编译通过（或 QuickJS fallback 验证）。

---

## Phase 3 — 回合内上下文压缩

**目标**：开启 Pi 自带 compaction，验证单 Turn 多轮工作流上下文可被压、不破坏正常多轮。

### 文件改动表

| 文件 | 改动 |
| --- | --- |
| `src/server/runtime/pi-agent-runtime.ts` | `compaction: { enabled: false }` -> `true`（约 547 行）；`session.setAutoCompactionEnabled(false)` -> `true`（约 583 行）。实施时调研 Pi 0.82.0 的 compaction 配置项（阈值 / 保留优先级），若可配则按「保留系统提示 + 当前 skill 主入口 + 当前轮 reference」配置。 |

### 测试

- `pi-agent-runtime.test.ts`：compaction enabled 后，session 创建参数含 `compaction.enabled: true`；`setAutoCompactionEnabled(true)` 被调用。
- 回归：现有 `long-form-hub` e2e（`npm run e2e` 的相关子集）仍绿 -- compaction 不破坏正常多 Turn 流程。

### 依赖

无。可与 Phase 1 / 2 并行。

### 验收门禁

`npm run check && npx vitest run pi-agent-runtime && npm run build` 全绿。

---

## Phase 4 — outline-designer 模板落地

**目标**：新建 `templates/outline-designer/`，用 Phase 1 的 sectionsPath + Phase 2 的 gate，落七轮单 Turn 自循环模板。

### 文件改动表

| 文件 | 改动 |
| --- | --- |
| `templates/outline-designer/template.yaml` | 新建（见 spec §6.2）。 |
| `templates/outline-designer/pipeline.yaml` | 新建（见 spec §6.3，单 Agent 无 routes）。 |
| `templates/outline-designer/agents/outline-designer.yaml` | 新建（见 spec §6.4，含 `skills[].sectionsPath` + `gate` + `turnContract`）。 |
| `templates/outline-designer/prompts/outline-designer-system.md` | 新建（见 spec §6.7，七轮顺序编排）。 |
| `templates/outline-designer/skills/outline-designer/SKILL.md` | 新建主入口：全局流程 + 七轮概要（每轮一句目标 + 产出文件名 + "详细读 `references/0N`"）+ 冻结规则 + 返修索引。不内联 references 全文。 |
| `templates/outline-designer/skills/outline-designer/references/01-08` | 8 份从远端 `/tmp/outline-designer-references/` 复制（已随本文档一并传到远端）：`01-source-boundaries.md` `02-facts-and-conflicts.md` `03-story-change-map.md` `04-character-pressure-map.md` `05-narrative-fingerprint.md` `06-blueprint-assembly.md` `07-outline-audit.md` `08-outline-repair.md`。 |
| `templates/outline-designer/gates/validate-blueprint.js` | 新建（见 spec §4.6）：CommonJS `module.exports = { validate }`，`validate({content, artifactType, context}) -> {pass, issues}`；校验 13 二级标题 / 每章 7 三级 / P0 带 `[FACT\|OBS @Lx-Ly]` / 冷开场 P0 不写「无」/ `## 分章执行卡` 标记。 |

### references 来源

8 份 reference 已随本文档一并传到远端 `/tmp/outline-designer-references/`（`01-source-boundaries.md` … `08-outline-repair.md`，内容与盐选定稿一致）。Phase 4 直接复制到 `templates/outline-designer/skills/outline-designer/references/`，**不要重新生成**。定稿要点：轮 2 的 `[FACT/OBS/INFER/PRIVATE @Lx-Ly]` 标签、轮 3 的 `Bxxx-P0-n` ID、轮 4 的情绪链+读者压力链分立、轮 6 的 13 标题 7 段、轮 7 的 JSON only、轮 8 的 `earliest_stage` 路由。

`/tmp/outline-designer-references/` 另含 2 份 JSON Schema：`outline-chapter-constraints.schema.json`（每章 required/forbidden_terms）、`outline-lifecycle.schema.json`（实体状态机：OBJ/CHR/EMO/SIG + transitions）。二者是**中间产物格式契约**（轮 1/2 章节约束、轮 3 故事变化图），**非**最终 blueprint 校验。处理：若模型需读，内联进对应 reference `.md`（sectionsPath 只收 `.md`）或扩展 sectionsPath 收 `.json`（实施时定）；**勿让 `validate-blueprint.js` 依赖它们**（沙箱无 FS，校验器须自包含）。

### 测试

- `template-loader.test.ts`：`outline-designer` 模板加载成功；`sections` 收集到 8 个 reference（`01-08`）；`gate.validator` 读入 snapshot；`versionHash` 稳定。
- `gate-runner.test.ts`：用 `templates/outline-designer/gates/validate-blueprint.js` 跑一份合规 blueprint fixture（pass）+ 一份缺标题的 fixture（reject + issues 含 stage）。
- `pipeline.test.ts`（若有模板校验测试）：`outline-designer` 通过模板 schema 校验（`turnContract` 合法、`gate` 合法）。

### 依赖

Phase 1（sectionsPath）+ Phase 2（gate）。Phase 3 不阻塞本 Phase（压缩是运行时优化，不影响模板结构）。

### 验收门禁

`npm run check && npx vitest run template-loader gate-runner && npm run build` 全绿；模板目录结构完整（`npm run check` 的模板校验通过）。

---

## Phase 5 — 集成验证（真实模型）

**目标**：用真实 DeepSeek 跑短对标故事，验证七轮闭环 + 结构门禁 + 最终提交 + 上下文不爆。

### 步骤

1. 确认 `.env` 含 `DEEPSEEK_API_KEY`（远端已配，**不得 echo**）。
2. 选一份短对标故事（2-3 章即可覆盖七轮，避免跑太久）作为 `source_story` 输入。
3. 起 dev server + cloudflared 隧道（见 CLAUDE.md「网页预览」），在 UI 创建 outline-designer 任务并提交。
4. 观察（dev server 日志 / UI 回合卡）：
   - Agent 依次 `load_skill` -> `read_skill_section(01)` -> `write_workspace(01-*)` -> ... -> `write_workspace(imitation-blueprint.md)` -> `write_workspace(07-outline-audit.json)` -> （若 reject）返修 -> `validate_artifact` -> `finish_production(workspace_file)` -> `submit_final_artifact`。
   - 七轮全部完成，最终 blueprint 落进产物版本目录。
   - 结构门禁：`validate_artifact` 返回 `pass`；提交时 commit 门禁未触发 `GATE_REJECTED`。
   - 上下文：全程不爆（compaction 生效，或即便不压也完成）。

### 验收门禁

- 任务终态为完成（`submit_final_artifact` 成功，最终 blueprint 在版本目录）。
- blueprint 结构合规（13 二级标题、每章 7 三级、P0 带标签）-- 人工抽检 + `validate-blueprint.js` pass。
- 上下文未溢出（日志无 context overflow 错误）。
- `npm run e2e`（含 outline-designer 的 e2e，若新增）绿。

### 依赖

Phase 1 + 2 + 3 + 4 全部完成。

---

## 回滚与风险

- **isolated-vm 编译失败**：fallback QuickJS（Phase 2 前置验证）；若两者都不行，降级为 `vm2`（已废弃但可用）或 Node 内置 `vm`（隔离弱，仅作最后手段，需在 spec 注明风险）。
- **compaction 副作用**：若 Phase 3 开 compaction 后 `long-form-hub` e2e 红，先回退（false），把手动选择性压缩单独立项；outline-designer 可先用 `deepseek-v4-pro` 的长上下文窗口硬扛（七轮 workspace 文件总量可控）。
- **远端 9 动作差异**：spec 基于 9 动作版；若远端 `action-committer` 的 `sealPackage` / `CommitContext` 结构与 spec 假设不符，以远端为准，门禁插入点选「sealedPackage 已确定、尚未写产物事件」处，记录偏差。
- **铁律回归**：每 Phase 验收时 grep 确认平台模块（`gate-runner` / `action-committer` / `skill-service` / `pi-tool-factory`）不含业务词。

---

## 实施顺序建议

Phase 1 -> Phase 2 -> Phase 3（或 1/2/3 并行）-> Phase 4 -> Phase 5。每 Phase 提交前 `git -C /Users/lzy/Desktop/ForgeCore status` + `npm run check && npm run test && npm run build`，提交时机由用户决定（不在远端随意 commit/push）。
