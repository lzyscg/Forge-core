# Forge Core v2 真模型集成排查报告（SDK / DeepSeek 卡死问题）

> 日期：2026-08-18（复核更新）
> 基线：`e815f10`；本次修复链当前提交为 `22c9ea5`
> 状态：**生产接线与无界 hang 已修复；真实 provider 失败仍按 retryable 记录**。原始 2026-08-17 现象保留为历史证据；本报告补充生产组合、真实 HTTP、运行时日志与浏览器复核结果。
> 当前 worktree：`codex/authoritative-review-real-mode`；主 checkout 的 `authoritative_review_v1` capability/profile 未被本次实验改写。

## 1. 现象

启动 `npm run dev`（带 `DEEPSEEK_API_KEY`），创建 v2 任务并 `POST /api/tasks/:taskId/start`，事件正确发出：

```
task_started
structured_map_build_started
structured_work_item_created
structured_work_item_leased
structured_assignment_dispatched
structured_agent_attempt_started_v2   <-- orchestrator Agent turn 已开始
```

之后 3+ 分钟内无任何新事件；`workspace` 始终显示 `currentAgent: None`、`nodes: 0`。**Pi turn 既不返回也不写 retry/terminal 事件**。

## 2. 已知能工作的事实（已验证）

| 验证项 | 结果 | 命令 / 文件 |
|---|---|---|
| DeepSeek direct API | 2 秒内返回 `deepseek-v4-flash` 正常响应 | `curl -X POST https://api.deepseek.com/v1/chat/completions -H "Authorization: Bearer ..."` |
| `ModelRuntime.create()` 解析 deepseek | `getModel('deepseek','deepseek-v4-flash')` 返回 model；`hasConfiguredAuth('deepseek')` = true | `scripts/_test-dep.mjs` |
| SDK 默认 listener 路径（Forge 测试 fixture 外的最小复现） | 843ms 跑完 14 个 event，包括 `agent_end` / `agent_settled` | `scripts/_test-dep5.mjs` |

### 2.8 ✅ **已关闭的 Forge 衔接缺口：生产 PiAgentRuntime 已注入 v2Tools**

生产 `CoreService` 现在把 task-aware `ProductionV2ToolRuntime` 通过 `v2Tools` 传给 `PiAgentRuntime`。`PiAgentRuntime.run()` 的 `createContext(input)` 会从当前持久化 lease/attempt 重建上下文，工具由 `V2ToolFactory` 按 session kind 关闭绑定；`V2AssignmentRunner` 不再预取一份与 Pi 无关的工具列表，结果引用则从同一个 task-scoped factory 收集。

这与旧测试路径的差异已经由 `production-composition.integration.test.ts`、`production-tool-runtime.test.ts` 和真实 HTTP 证据覆盖：生产结构回合实际暴露 `read_structure_contract`、`read_map_build_frontier`、`append_map_candidate_chunk`、`finish_map_build` 四个工具，并使用 lease owner 作为 authority identity，而不是冻结 Agent 的 role id。

因此，原先“生产没有 v2Tools”已不再是当前根因。剩余 provider/SDK 行为必须用真实运行日志判断，不能再从旧的 `agent_attempt_started_v2` 停滞现象推断为空工具导致。

## 2.9 ✅ 2026-08-18 真实生产复核结果

在独立 worktree、全新临时数据根目录、`FORGE_CORE_MODE=production`、`VITE_FORGE_CORE_MODE=http` 下启动实际 HTTP 服务，并通过 HTTP 创建/启动 `zhihu-salt-chapter-draft` 任务。观察到的生产日志顺序为：

```text
v2 context ready (... tools=4 names=read_structure_contract,read_map_build_frontier,append_map_candidate_chunk,finish_map_build)
session creating (... v2Tools=4 forgeTools=0)
turn started (... v2Tools=4 forgeTools=0)
prompt dispatch (... inputChars=201)
tool started read_structure_contract / finished error=false
tool started read_map_build_frontier / finished error=false
turn failed code=PROVIDER_ERROR
```

对应事件已经从“只停在 `structured_agent_attempt_started_v2`”变为完整的 retryable envelope：

```text
structured_agent_attempt_retryable_failed_v2 (failureCode=PROVIDER_ERROR)
structured_work_item_retryable_failed (retryOrdinal=1, retryNotBefore=...)
```

这证明真实 Pi turn 已经进入并调用封闭 v2 工具，provider 错误会在有限时间内释放 lease 并写入重试状态，而不是无限等待或让 HTTP 请求抛裸协调器异常。另一个无领域结果载体的路径由 runner 归类为 `V2_RESULT_REFS_MISSING`，同样通过 retryable envelope 结束，不会把 §9.2 的 `INVALID_INPUT` 直接暴露成 500。

浏览器以同一 HTTP build 打开 `/tasks` 与任务详情页，能看到真实创建的任务、`running` 状态、四个 agent region 和停止操作；截图保存在 `output/playwright/real-mode-tasks-http.png`、`output/playwright/real-mode-task-detail.png`（这些是本次 worktree 的临时验收产物）。浏览器没有运行时 error，只有 React Router future warnings。

当前仍需明确的边界：`ProductionV2DomainRuntimeFactory` 已真实组合 structure/map build、generation、repair、map/content review、validator 与 seal 依赖，但 `MigrationServiceV2` 的完整生产构造尚未完成。迁移 command 现在显式返回 `MIGRATION_RUNTIME_NOT_WIRED` 的 terminal fail-closed 结果，不再使用 `NOT_IMPLEMENTED` retryable stub 假装可运行；因此“初始结构任务真实可运行”已被证明，而“包含 migration 的全生命周期”仍不能宣称完成。


> 历史结论（修复前）：完整 Forge 路径上 Pi turn 不返回；最小 SDK 路径能 843ms 返回。差异来自 Forge 注入的额外 seam。§2.8–§2.9 是当前复核后的结论。

## 3. SDK 卡死路径（已观察到 / 怀疑）

Forge 实际传给 `createAgentSession` 的关键选项（`src/server/runtime/pi-agent-runtime.ts:882-898`）：

```ts
const session = await this.#createSession({
  cwd, model: binding.model, modelRuntime: binding.modelRuntime,
  sessionManager, settingsManager, resourceLoader,   // <-- Forge resourceLoader
  noTools: 'builtin', customTools: [
    ...forgeTools,                                  // workspace/skill/validate-artifact
    ...(structuredCtx?.toolDefinitions ?? []),
    ...(v2Ctx?.toolDefinitions ?? []),              // <-- v2 tools (orchestrator/generator/reviewer)
  ],
});
// 之后
session.agentSubscribe(createForgePiSlotPreflight(...))   // <-- raw agent listener (AWAITED by SDK)
session.subscribe(...)                                    // <-- session-level trace listener
```

可疑点（按优先级）：

1. **`session.agentSubscribe` 的 listener 形状**：`createForgePiSlotPreflight` 返回 `(event, signal) => Promise<void>`。SDK 0.82 的 `agent.subscribe(listener)` **AWAIT** 每个 listener 的 promise（`_handleAgentEvent` 内部 `await this._emitExtensionEvent(event)`，preflight 是同一路径）。如果 listener 抛出未捕获 promise rejection，事件链可能死锁。
2. **v2 tool definitions**：orchestrator Agent 的 `v2Ctx.toolDefinitions` 来自 Task 21 production-composition，但 Task 25 才迁移模板到 v2 contract；旧 fixture 或未对齐的模板 hash 可能让 toolDefinitions 引用 stale 资源。
3. **`DefaultResourceLoader({cwd, agentDir, ...noX: true})`**：Forge 自己的 resourceLoader（继承 SDK）。`agentDir` 缺失/不存在可能导致 `loader.reload()` 之后的内部初始化挂住；我在最小测试里**用了 `DefaultResourceLoader` 但没指定 `agentDir`**，仍能跑通 → 大概率不是 root cause 但仍待验证。
4. **DeepSeek reasoning 模型 + `requiresReasoningContentOnAssistantMessages: true`**：Forge 的 `replayPublicHistory` 在 SDK emit `message_start` 后插入历史消息，可能与 reasoning 通道冲突；最小测试中**纯 prompt（无 replay）**能 843ms 完成 → 大概率是 root cause 的子触发条件。
5. **`session.subscribe` listener 类型不匹配**：Forge 的 listener 是 `(event) => void`，但 SDK emit 的某些事件有 `assistantMessageEvent` 字段；listener 中访问 `event.message.content` 对 reasoning 模型可能拿到空 `content` 数组，触发下游 `extractPublicText` 返回 `''`；这不会卡死但会让 trace 失真。

## 4. 已被排除的怀疑

- **API key 注入**：env 显式 `env -i HOME= PATH= DEEPSEEK_API_KEY= node` 也 OK，`hasConfiguredAuth` 返回 true。
- **ModelRuntime 解析**：deepseek v4-flash/v4-pro 都被正确解析；`deepseek-chat` 在 SDK 中**未注册**（这是 SDK 0.82 的限制，不是我们的）。
- **deepseek v4-flash 本身卡死**：直 curl 2 秒返回；SDK 最小路径 843ms 完成。
- **Forge v2 capability gate**：`authoritative_review_v1` status=enabled、profile digest 匹配、executionEligibility=eligible、事件流正确发出 task_started → agent_attempt_started_v2。
- **worktree / capability promote**：本次修复在隔离 worktree 完成；主 checkout 的 capability/profile 未被改写。修复前的 `e815f10` 事实保留，当前生产接线证据见 §2.9。

## 5. 复现命令（接手者直接跑）

```bash
cd /Users/lzy/Desktop/ForgeCore
# 1) 服务
env -i HOME="$HOME" PATH="$PATH" DEEPSEEK_API_KEY=sk-... \
  FORGE_CORE_DATA_ROOT=$PWD/data FORGE_CORE_PORT=3210 VITE_FORGE_CORE_MODE=http \
  npm run dev &

# 2) 创建 v2 任务
TID=$(curl -s -X POST http://127.0.0.1:3210/api/tasks -H 'Content-Type: application/json' -d '{
  "templateId": "zhihu-salt-chapter-draft",
  "name": "test 排查",
  "input": {
    "chapter_packet": "...",
    "previous_draft": "",
    "repair_order": ""
  }
}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 3) start
curl -X POST http://127.0.0.1:3210/api/tasks/$TID/start

# 4) 等 30s 看 events（应出现 completed / retryable_failed / terminal_failed，而不是无界停在 attempt_started）
ls -la data/tasks/$TID/events/

# 5) 看 server stderr（dev 模式下 stderr 暴露 SDK 内部错误）
tail -100 dev.log 2>/dev/null
```

期望（修复后）：事件流在 30 秒内出现 `structured_agent_attempt_completed_v2` 或 `structured_agent_attempt_terminal_failed_v2` / `structured_agent_attempt_retryable_failed_v2`。

## 6. 已执行的修复与剩余验证

### 已关闭

- 生产 `runTick()` 对每个新 lease 调用 `V2AttemptCoordinator.executeLeased()`，不再只写 lease/attempt-start 事件。
- `CoreService` 注入 task-aware `ProductionV2ToolRuntime`，Pi 与结果收集共享同一 `V2ToolFactory` 作用域；日志记录了工具数量/名称、turn 起止、tool 起止和失败码，字段经过脱敏。
- preflight listener 的异常现在被记录后重新抛出；attempt timeout、provider failure、abort 均走既有 durable retry/abort 语义。
- 结构化回合没有非空 `resultRefs` 时返回 `V2_RESULT_REFS_MISSING` retryable outcome，避免裸完成穿透到 coordinator 并变成 HTTP 500。
- 增加了 production composition、tool runtime、runner、API 和 scheduler 回归；实际 HTTP + Playwright 验收见 §2.9。

### 尚未宣称完成

- 真实 DeepSeek/provider 在本次复核中仍返回 `PROVIDER_ERROR`，但已在有限时间内写 retryable envelope；这证明“有界失败”而不是“provider 已成功完成”。若要证明真实模型成功产出 Map，还需在 provider 可用且模型实际调用写工具后重新运行。
- `MigrationServiceV2` 尚未完成生产构造；迁移 command 明确 terminal fail-closed (`MIGRATION_RUNTIME_NOT_WIRED`)。应单独完成 migration composition 和真实迁移 HTTP/浏览器验收，不能把当前初始结构链路证据外推为全生命周期证据。
- SDK/DeepSeek reasoning 兼容性仍可独立升级研究，但不再是“无限挂死未收敛”的生产阻塞；当前应先保留已验证的超时、诊断和 retry 证据。

## 7. 已写但已删除的排查脚本

为了避免污染仓库，下列临时测试文件**已删除**（不属于产品实现）：

- `scripts/_test-dep.mjs` — ModelRuntime 直测（deepseek 解析 OK）
- `scripts/_test-dep2.mjs` — `hasConfiguredAuth` / `getAuth(deepseek)` 验证（keyLen=35，来源 stored credential 实为 env fallback）
- `scripts/_test-dep3.mjs` — prompt + listener + 真实事件流（30s+ 超时，证明 Forge 全链路挂起）
- `scripts/_test-dep4.mjs` — 列出可用 deepseek 模型（仅 v4-flash/v4-pro，无 deepseek-chat）
- `scripts/_test-dep5.mjs` — **关键：843ms 内 turn 完整 14 事件，证明 SDK+DeepSeek 单 prompt 路径正常**

需要时直接重新写。

## 8. 关键文件参考

- `src/server/runtime/pi-agent-runtime.ts:782-1080`：`run()` 主路径，含 listener 注册、prompt 调用、错误捕获
- `src/server/runtime/pi-agent-runtime.ts:925-955`：`session.subscribe(trace listener)`，best-effort trace + 脱敏诊断日志
- `src/server/runtime/pi-agent-runtime.ts:910-914`：`structuredUnsubscribe = session.agentSubscribe(createForgePiSlotPreflight(...))`
- `src/server/runtime/pi-resource-loader.ts:79-95`：`createForgeResourceLoader` 继承 `DefaultResourceLoader` 全 noX
- `src/server/authoritative-review/attempt-coordinator.ts:362-422`：`executeLeased`，包含 lease/timeout 复合 signal
- `src/server/authoritative-review/assignment-runner.ts:87-143`：`runSession`，v2 turn 输入装配（`v2Session: {signal}`, `slotSession: null`）
- `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:280-292`：`_emit` 无 try/catch；listener 抛错会冒泡
- `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:453-510`：`_handleAgentEvent` 内部 `await this._emitExtensionEvent(event)`（preflight listener 走这条路径，async 拒绝会成 unhandled rejection）
- `templates/zhihu-salt-chapter-draft/agents/*.yaml`：当前 4 个 agent 都绑定 `deepseek/deepseek-v4-flash`（本地 dev 切换，commit `f5b23ff`）

## 9. 接手者 Checklist

- [x] 读本文 + `src/server/runtime/pi-agent-runtime.ts` + Pi SDK event path
- [x] 暴露脱敏 stderr 生命周期日志并验证真实 HTTP 事件收敛
- [x] 完整 Forge production composition/tool runtime integration test
- [x] 增加缺少结果引用、timeout、provider failure、abort 的 TDD 回归
- [x] 运行 check/build、authoritative acceptance、全量回归（全量首跑仅有一个已同步的旧断言，修正后相关 24 tests 全绿）
- [ ] 完成 `MigrationServiceV2` 的生产构造并通过真实迁移任务验收
- [ ] 在 provider 可稳定返回时取得真实模型成功写入工具结果的证据

## 10. 后续债务（已登记于 CLOSURE-AUTHORITATIVE-REVIEW-V2.md）

- N2（发布 recipe 未交叉校验 reviewBundle 内部 refs）— 执行期 resolver 兜底，不可利用
- N4（旧 checkpoint mergedArtifactVersion 归一）— v2 尚未进生产
- N5/N6（公开 capability 工厂边界、migration production composition 尚未完成）— 当前非 migration 初始结构/工具路径已接通，其余缺口显式 fail-closed
- **N7（更新）：真实 Pi 0.82 + DeepSeek reasoning provider 曾在 `agent_attempt_started_v2` 后无界停滞；当前已能记录工具调用和 `PROVIDER_ERROR` retryable envelope。剩余工作是 provider 成功写入的真实证据与 SDK 兼容性长期优化。**
