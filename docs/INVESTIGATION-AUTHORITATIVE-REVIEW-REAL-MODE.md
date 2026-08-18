# Forge Core v2 真模型集成排查报告（SDK / DeepSeek 卡死问题）

> 日期：2026-08-17
> HEAD：e815f10
> 状态：**未修复**，已暂停排查（API 配额用尽）；本报告记录事实、根因怀疑、已排除项、复现命令与下一步计划。
> 接手者：`codex/authoritative-review-v2` worktree（已合并回 main），分支 `main` 当前已 enable `authoritative_review_v1`，profile digest `f4685a55...`。

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

### 2.8 ✅ **已确认的 Forge 衔接缺口：生产 PiAgentRuntime 没注入 v2Tools**

生产 `CoreService` 在 `src/server/core-service.ts:502-506` 创建 `new PiAgentRuntime({ coreCwd, workspaces, structuredSlot })`，但没有传入 `v2Tools`。`PiAgentRuntime.run()` 在 `src/server/runtime/pi-agent-runtime.ts:796-798` 只有当 `this.#v2Tools !== undefined` 时才调用 `createContext(input)`；因此真实 v2 `AssignmentRunner`（`assignment-runner.ts:102-104` 设置 `v2Session`）在生产路径里拿不到 `read_map_build_frontier`、`append_map_candidate_chunk`、`finish_map_build` 等封闭 v2 工具。

这与测试路径不同：`pi-agent-runtime.test.ts:1715-1842` 显式注入 `v2Tools`，所以测试 green 不证明生产 v2 tool seam 已接通。Task 21 `production-composition.ts` 的注释也明确 Task 13 tool factory 尚未 wiring，当前 production `toolProvider` 返回空集合；这不是 DeepSeek API 或 SDK 单独问题，而是 Forge composition 的已确认前向依赖/衔接缺口。它解释了为什么 `structured_agent_attempt_started_v2` 已落盘后没有合法 Map chunk/result 继续事件；但 Agent turn 本身仍需 instrument 证明是否因空工具集合而挂起。

**结论更新**：在修改 SDK 前，必须先把生产 `PiAgentRuntime.v2Tools` 注入真实 `V2ToolFactory`/`ToolProvider`，并写一条 production composition integration test；随后再复现，才能隔离剩余 SDK/DeepSeek listener 问题。


完整 Forge 路径上 Pi turn 不返回；最小 SDK 路径能 843ms 返回。差异来自 Forge 注入的额外 seam。

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
- **worktree / git / capability promote**：HEAD `e815f10`，origin/main 同步，干净。

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

# 4) 等 30s 看 events（orchestrator Agent turn 应当完成 / 失败，但实际卡住）
ls -la data/tasks/$TID/events/

# 5) 看 server stderr（dev 模式下 stderr 暴露 SDK 内部错误）
tail -100 dev.log 2>/dev/null
```

期望（修复后）：事件流在 30 秒内出现 `structured_agent_attempt_completed_v2` 或 `structured_agent_attempt_terminal_failed_v2` / `structured_agent_attempt_retryable_failed_v2`。

## 6. 下一步计划（按优先级，建议接手者直接执行）

### 优先级 1：在 listener 里加日志暴露 SDK 内部错误
Forge `session.subscribe` 的 listener 用 `try { ... } catch { drop silently }` 吞掉异常；这是设计选择（trace 收集防御性），但当 SDK 在 emit 时同步抛错（preflight listener 的 async 拒绝）会冒泡到 `agent_session.js:289` 的 `l(event)`，让 turn 卡住。

建议：在 `session.subscribe` 的 catch 里 `console.error` 一行（dev 模式可见），并把 SDK `_handleAgentEvent` 处的 unhandled promise rejection 也暴露——用 `process.on('unhandledRejection', ...)` 临时打印。

```ts
// src/server/runtime/pi-agent-runtime.ts:925 的 listener
} catch (err) {
  console.error('[forge] listener threw:', err instanceof Error ? err.message : String(err));
}
```

跑一遍上面的复现命令，看 stderr 里打印出什么。

### 优先级 2：测试 v2 真实链路（不只是最小 SDK）
写一个完整 Forge 路径的集成测试，包含 `DefaultResourceLoader({cwd, agentDir, noX:true})` + `customTools: [forgeTools]` + `agentSubscribe(preflight)` + `session.subscribe(trace)`。验证：
- (a) 不带 `customTools` 843ms 完成（baseline 已通过）
- (b) 带 `customTools: []` 同样 843ms
- (c) 带 `customTools: [forgeTools]` **是否卡死** → 如果卡死，问题在 forge tools 注入
- (d) 加 `agentSubscribe` listener（async preflight） → 如果卡死，问题在 preflight listener 形状

### 优先级 3：DeepSeek reasoning 模型兼容
Forge 默认模板 `deepseek/deepseek-v4-flash` 是 `reasoning: true` + `requiresReasoningContentOnAssistantMessages: true`。SDK 0.82 的 `DefaultResourceLoader`/`AgentEvent` 处理路径可能假设 non-reasoning。

短期方案：模板 agent model 切回 `opencode/claude-haiku-4-5`（或任何 non-reasoning 模型），验证 Pi turn 跑通——已用 deepseek 在小测试里能跑，所以模型本身没问题；如果切回 opencode 跑通，差异就在 reasoning 通道。

长期方案：要么换 SDK 版本，要么在 Forge listener 里显式处理 `assistantMessageEvent.reasoning_content`。

### 优先级 4：SDK 升级可能性
检查 `@earendil-works/pi-coding-agent` 后续版本是否修复了 `agent.subscribe` listener 形状与 reasoning 模型的兼容问题。

## 7. 已写但已删除的排查脚本

为了避免污染仓库，下列临时测试文件**已删除**（git 状态干净，HEAD `e815f10`）：

- `scripts/_test-dep.mjs` — ModelRuntime 直测（deepseek 解析 OK）
- `scripts/_test-dep2.mjs` — `hasConfiguredAuth` / `getAuth(deepseek)` 验证（keyLen=35，来源 stored credential 实为 env fallback）
- `scripts/_test-dep3.mjs` — prompt + listener + 真实事件流（30s+ 超时，证明 Forge 全链路挂起）
- `scripts/_test-dep4.mjs` — 列出可用 deepseek 模型（仅 v4-flash/v4-pro，无 deepseek-chat）
- `scripts/_test-dep5.mjs` — **关键：843ms 内 turn 完整 14 事件，证明 SDK+DeepSeek 单 prompt 路径正常**

需要时直接重新写。

## 8. 关键文件参考

- `src/server/runtime/pi-agent-runtime.ts:782-1080`：`run()` 主路径，含 listener 注册、prompt 调用、错误捕获
- `src/server/runtime/pi-agent-runtime.ts:925-955`：`session.subscribe(trace listener)`，try/catch 静默吞掉
- `src/server/runtime/pi-agent-runtime.ts:910-914`：`structuredUnsubscribe = session.agentSubscribe(createForgePiSlotPreflight(...))`
- `src/server/runtime/pi-resource-loader.ts:79-95`：`createForgeResourceLoader` 继承 `DefaultResourceLoader` 全 noX
- `src/server/authoritative-review/attempt-coordinator.ts:362-422`：`executeLeased`，包含 lease/timeout 复合 signal
- `src/server/authoritative-review/assignment-runner.ts:87-143`：`runSession`，v2 turn 输入装配（`v2Session: {signal}`, `slotSession: null`）
- `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:280-292`：`_emit` 无 try/catch；listener 抛错会冒泡
- `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:453-510`：`_handleAgentEvent` 内部 `await this._emitExtensionEvent(event)`（preflight listener 走这条路径，async 拒绝会成 unhandled rejection）
- `templates/zhihu-salt-chapter-draft/agents/*.yaml`：当前 4 个 agent 都绑定 `deepseek/deepseek-v4-flash`（本地 dev 切换，commit `f5b23ff`）

## 9. 接手者 Checklist

- [ ] 读本文 + `src/server/runtime/pi-agent-runtime.ts:782-1080` + `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:280-510`
- [ ] 应用优先级 1（暴露 stderr），重跑复现命令，记录 SDK 实际抛错
- [ ] 应用优先级 2（完整 Forge listener 集成测试），定位卡死点
- [ ] 优先级 3（切回 non-reasoning 模型）作为短期绕路
- [ ] 找到 root cause 后修复并新增针对性 TDD 测试
- [ ] 跑 `npm run check && npm test -- --reporter=dot` 全绿
- [ ] 写收尾 fix commit + push
- [ ] 更新本文件 "状态" 字段并把发现加入 `docs/CLOSURE-AUTHORITATIVE-REVIEW-V2.md` 后续债务清单

## 10. 后续债务（已登记于 CLOSURE-AUTHORITATIVE-REVIEW-V2.md）

- N2（发布 recipe 未交叉校验 reviewBundle 内部 refs）— 执行期 resolver 兜底，不可利用
- N4（旧 checkpoint mergedArtifactVersion 归一）— v2 尚未进生产
- N5/N6（公开 capability 工厂边界、生产未接五个 domain services）— 前向依赖
- **N7（本报告新增）：真实 Pi 0.82 + DeepSeek reasoning 模型下 Agent turn 卡在 `agent_attempt_started_v2` 之后、`agent_attempt_terminal_failed_v2` 之前；hermetic-only 路径走通但 real-mode 阻塞**
