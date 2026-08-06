# 产物版本目录制 — 开发规划（Development Plan）

> 状态：**定稿（Final）**，对齐设计 v7（六轮对抗审查收敛，无阻断，可进入实施）。
> 上游：设计 `docs/2026-08-06-artifact-version-directory.md`（v7）；规格 `docs/2026-08-07-artifact-version-directory-spec.md`。
> 人工介入（Phase 5）的 supersede+synthesize 机制已在设计 v7 定稿（含兜底合成目标、崩溃自愈、accept 服务端复校验），Phase 5 可实施。

---

## 总体策略

- 自底向上分 8 个 Phase，每个 Phase 内 TDD（先测试后实现），Phase 间标注依赖。
- 每 Phase 结束跑门禁：`npm run check` + 相关 vitest。全部完成跑全量（check/test/e2e/build/verify）。
- 涉及共享契约（事件联合/注册表）的 Phase 优先，避免后期连锁返工。

**依赖图**：
```
Phase 0 (事件/契约) ─┬─> Phase 1 (存储)
                    ├─> Phase 2 (动作/工具)
                    └─> Phase 3 (模板契约)
Phase 1 + 2 + 3 ──> Phase 4 (runner + committer)
Phase 4 ──> Phase 5 (调度器人工介入)   ← 依赖 v6 定稿
Phase 4 ──> Phase 6 (投影 + UI)
全部 ──> Phase 7 (迁移 + 集成验证)
```

---

## Phase 0 — 事件契约与数据模型（地基）

**目标**：新事件成员、字段变更、legacy 归一，为上层铺地基。

| 文件 | 改动 |
|---|---|
| `src/server/storage/task-events.ts` | `artifact_annotated` 成员；`artifact_published.files[]/artifactType/artifactId`；`agent_result.inputNodeId+dispatchKind`（可选）；输入节点 `inputVersion`；`task_incompatible.SCHEMA_V2_REQUIRED`；**humanAuthorized 字段（见 v6）** |
| `src/server/storage/event-store.ts` | 读取期键归一 transform（仅 artifactVersion→inputVersion）；新字段可选校验 |
| `src/shared/contracts.ts` | `ArtifactVersion.files[]`；输入节点 `inputVersion` |

**测试**：事件 schema 校验、legacy transform（旧事件读取不 CORRUPTED、新事件写入齐全）、新成员 fail-closed。
**依赖**：无。

---

## Phase 1 — 存储层

**目标**：多文件版本目录、事件权威版本号、annotate 幂等、staging 认领。

| 文件 | 改动 |
|---|---|
| `src/server/storage/artifact-store.ts` | 注入 EventStore；版本号=已提交事件数；annotate staging + 唯一性（重放自排除）；staging 哈希认领（artifactId 优先/多同哈希取一）；复扫盘↔事件交叉校验；meta 保 id；读窗口容忍 |

**测试**：staging 认领各分支、annotate 唯一性（含重放自排除）、版本事件计数、多文件复扫 fail-loud、meta 双读。
**依赖**：Phase 0。

---

## Phase 2 — 动作与工具

**目标**：注册表 6→9，新动作校验，阶段机扩展。

| 文件 | 改动 |
|---|---|
| `src/server/runtime/forge-actions.ts` | 注册表 6→9；annotate/forward/多文件 finish 校验；dispatchKind；send_message 简短 body |
| `src/server/runtime/action-buffer.ts` | 两类回合；封存仅 finish；人工中断（F7 翻转）；结构顺序校验 |
| `src/server/runtime/pi-tool-factory.ts` | annotate（frontmatter + file 归属，工具层校验）；forward；read_artifact_version；send_message 简短 body；inputVersion/turnContract 上下文注入；**F7 翻转后工具文案/checklist 重写** |

**测试**：动作校验（新形状）、阶段机（封存仅 finish、人工中断位置）、工具层 frontmatter/file 归属校验、注册表 verbatim。
**依赖**：Phase 0。

---

## Phase 3 — 模板契约

**目标**：turnContract v2、artifactSchema、route.inject、模板迁移。

| 文件 | 改动 |
|---|---|
| `src/server/template/template-schema.ts` | turnContract v2 形状（含 dispatch-only 推导规则、production.sources 恢复）；FrozenTemplate.artifactSchema + budget(模板级) |
| `src/server/template/template-validator.ts` | artifactSchema/route.inject/产物边必声明 required inject/annotate/forward targets 交叉校验 |
| `src/server/template/template-loader.ts` + `template-cache.ts` | v2 哈希；cache 归一化 |
| `templates/` | 删 zhihu-single-chapter；重写 long-form-hub（**reviewer→controller 改 artifact 边**） |

**测试**：turnContract v2 形状校验、回合类型推导（含 dispatch-only controller）、混合 Agent 拒绝、artifactSchema/route.inject 交叉校验、模板加载/哈希。
**依赖**：Phase 0。

---

## Phase 4 — 运行时（runner + committer）

**目标**：inject 执行期解析、输入版本传播、committer 新规则。

| 文件 | 改动 |
|---|---|
| `src/server/runtime/task-runner.ts` | inject 执行期解析（锚定 inputVersion）；inputText inject 供料；合成节点 inputText；handOff→inputVersion；**forward 确定性节点 id** |
| `src/server/runtime/action-committer.ts` | annotate staging 提交序 + 唯一性（自排除）；可达性闭包（inputNodeId 连接 + 人工放宽）；输入版本传播；dispatchKind 驱动完成检测；语义矩阵；**committer 重放触发认领** |

**测试**：committer 规则（annotate 唯一性/可达性闭包/输入版本传播/dispatchKind 扇出）、inject 执行期解析、语义矩阵、快乐路径端到端。
**依赖**：Phase 1 + 2 + 3。

---

## Phase 5 — 调度器人工介入（依赖 v6 定稿）

**目标**：progress-guard 结构化决策（continue/accept/stop）。

> 设计已定稿（v7）：supersede+synthesize 机制 + humanAuthorized 字段 + accept 前提 + 兜底/崩溃自愈均已定（见设计 §11/§7.1）。本 Phase 按设计实施。

| 文件 | 改动 |
|---|---|
| `src/server/runtime/task-scheduler.ts` | progress-guard 结构化决策；accept 合成节点给 controller + humanAuthorized；continue 引导注入；**悬空 pending 输入 supersede 协议**；guard 问题文案 |
| `src/server/api/*` + `api-schemas.ts` | 结构化决策 API 形状（decision + 可选 text）；waiting_human 来源判别 |

**测试**：continue/accept/stop 三分支、悬空输入 supersede、humanAuthorized 封闭性、零版本 accept 边界、waiting_human 来源判别。
**依赖**：Phase 4 + **设计 v6**。

---

## Phase 6 — 投影与 UI

**目标**：新事件投影、产物链渲染、accept 决策 UI。

| 文件 | 改动 |
|---|---|
| `src/server/storage/task-projector.ts` + mock | 新事件折叠；inputVersion 消费；superseded 输入表示；mock/real 投影一致 |
| 产物链 UI（artifact-drawer 等） | extract 槽位渲染（content/review/revision）；verdict 展示；annotate 归属；旧任务降级；accept 决策 UI |

**测试**：投影一致性（mock/real）、产物链 extract 渲染、verdict 展示、旧任务降级。
**依赖**：Phase 4（投影）；accept UI 依赖 Phase 5。

---

## Phase 7 — 迁移 + 集成验证

**目标**：迁移落地、全量验证。

| 项 | 内容 |
|---|---|
| 迁移 | incompatible gate（SCHEMA_V2_REQUIRED）；legacy 事件读取兼容验证；克隆代际 gate |
| 集成 | e2e 重写（long-form-hub 端到端）；forge-actions verbatim；mock/real 一致；annotate/forward/human 专项 |
| 全量门禁 | `npm run check` + `npm test` + `npm run e2e` + `npm run build` + `verify:backend/runtime` |

**依赖**：全部。

---

## 验证门禁总表

| 门禁 | 命令 | 时机 |
|---|---|---|
| 类型检查 | `npm run check` | 每 Phase |
| 单元/集成 | `npm test` | 每 Phase + 全量 |
| e2e | `npm run e2e` | Phase 7 |
| 构建 | `npm run build` | Phase 7 |
| 后端/运行时验证 | `npm run verify:backend` / `verify:runtime` | Phase 7 |
| 真实验收（可选） | `npm run acceptance:real` | Phase 7 后 |

---

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 人工介入模型未收敛（v6 前） | Phase 5 后置，先做 Phase 0-4/6 稳定部分 |
| 事件联合/注册表连锁变更 | Phase 0/2 优先，测试先行 |
| legacy 兼容回归 | Phase 0 legacy transform 专项测试 |
| 可达性闭包改动影响现有 submit | Phase 4 快乐路径端到端测试 |
| 模板拓扑重写（artifact 边） | Phase 3 模板验收测试钉死 |

---

## 设计定稿项（已在 v7 解决，不阻塞）

以下原阻塞项均已在设计 v7 定稿（六轮审查收敛）：
1. ✅ accept/continue 的悬空 pending 输入处置协议（supersede，设计 §11.1/11.2）
2. ✅ continue 引导文本的执行期注入机制（synthesize 节点 body，设计 §11.1）
3. ✅ humanAuthorized 字段定义 + 封闭性论证（设计 §7.1）
4. ✅ accept 零版本边界、waiting_human 来源判别（设计 §11.5）
5. ✅ dispatch-only Agent（controller）回合推导 + production.sources 恢复（设计 §15）
6. ✅ 多 pending 拓扑下 continue 目标选择（supersede 全部 + 合成给最老接收者，设计 §11.3）
7. ✅ forward 节点 id（`${turnId}-forward-input-0`）、forward 边类型（artifact）、committer 重放认领点（设计 §8.2/§7/§6）
8. ✅ 兜底合成目标、崩溃自愈、accept 服务端复校验、协调回合表述统一（设计 §11.4/11.6/11.5/§15）
