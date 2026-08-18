# 真实 Pi turn 卡死 — 排查进度报告

> 日期：2026-08-17  
> 状态：**已暂停（API 套餐用尽）**  
> 提交：docs/INVESTIGATION-AUTHORITATIVE-REVIEW-REAL-MODE-PI-CARD.md  
> HEAD：`f5b23ff chore: switch zhihu template agents to deepseek/deepseek-v4-flash`

## 1. 现象

Forge v2 模板（`templates/zhihu-salt-chapter-draft`，v2 contract，orchestrator/generator/reviewer 三个 Agent 绑定 `deepseek/deepseek-v4-flash`）经 HTTP 走 `POST /api/tasks` → `POST /api/tasks/:id/start` 后，事件账簿正确发出：
- `task_started`、`structured_map_build_started`、`structured_work_item_created`（snapshot of MapBuildSpec + WorkItem）
- `structured_work_item_leased`、`structured_assignment_dispatched`、`structured_agent_attempt_started_v2`

之后 **Agent turn 不返回任何事件**，超过 3+ 分钟仍无 `agent_end`/`agent_settled`/`message_end`。`task.currentAgentName` 一直为 `null`。Capability `executionEligibility.state='eligible'`（digest `f4685a55...` 匹配），不是因为 capability 阻塞。

## 2. 已排出的可能原因

### 2.1 ✅ 模型解析与凭据
- `ModelRuntime.create({allowModelNetwork: false})` 正常解析 `deepseek/deepseek-v4-flash`（`scripts/_test-dep.mjs` 验证）
- 默认 `defaultAuthContext` 通过 `process.env` 读取 `DEEPSEEK_API_KEY`，SDK `getAuth('deepseek')` 返回 `{ source: 'stored credential', hasApiKey: true, keyLen: 35 }`（实测脚本 `scripts/_test-dep2.mjs`）
- DeepSeek direct API（绕过 SDK）：
  ```bash
  curl -X POST https://api.deepseek.com/v1/chat/completions -H "Authorization: Bearer sk-..." \
    -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"用一个词"}],"max_tokens":50}'
  # 返回 200，模型正常响应（reasoning_content 因 deepseek-v4-flash 是 reasoning 模型）
  ```
  网络/凭据/推理链路本身 OK。

### 2.2 ⚠️ SDK listener 形状与 Forge 包装层
- `PiSessionEventLike`（`pi-agent-runtime.ts:101`）与 SDK `AgentSessionEvent` 同源（`message_update`/`tool_execution_start`/`tool_execution_end` 等）
- `defaultPiSessionFactory`（`pi-agent-runtime.ts:171`）封装正确的 listener：(event) => void / (event, signal) => Promise<void>
- 隔离最小 SDK 测试（脚本 `scripts/_test-dep5.mjs`）**仅用 `session.subscribe((event)=>{...})` + `session.prompt`**：843ms 内产生 14 个事件（agent_start / turn_start / message_start / message_update / message_end / turn_end / agent_end / agent_settled），turn 正常完成 → **listener 形状没问题**
- **关键差异**：Forge 真实路径还会多注册 `session.agentSubscribe(...)` 用于 preflight（spec Task 14），两者并存的兼容性未测

### 2.3 ⚠️ ⚠️ **`_handleAgentEvent` 内部 `_emitExtensionEvent` 行为**
`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:455-501`：所有 event 类型（`message_update`、`tool_execution_start`、`tool_execution_end`...）在 `_emit` 给用户 listener 之前都先 `await this._extensionRunner.emit(extensionEvent)`。SDK 默认 `extensionRunner` 是否有 handler、会不会因为 `await` 而阻塞整个 turn，**未在 trace 里看到证据**。

### 2.4 ⚠️ ⚠️ ⚠️ **可疑高优：[推理模型 assistant message 格式]**
DeepSeek v4-flash / v4-pro 是 reasoning 模型：deepseek.models 配置里有：
```js
compat: {
  requiresReasoningContentOnAssistantMessages: true,
  thinkingFormat: 'deepseek',
}
```
SDK 在 emit assistant message 时可能将其视为不完整（若 reasoning_content 与 content 不匹配 SDK 期望），触发 `message_end` 时的额外校验/重试分支。但隔离 SDK 测试观察到完整 message_end 行为正常，需进一步对照 Forge 真实路径差异。

### 2.5 ❓ v2 tools 是否注册
`runtime/authoritative-review/tool-factory.ts:createContext` 对 v2 turn 返回 ToolDefinition 数组；`pi-agent-runtime.ts:897` 把这些 tools 通过 `customTools: [...forgeTools, ...v2Ctx.toolDefinitions]` 注入。但 orchestrator/generator/reviewer 用的工具集是否需要真实存在的 `authoritative-review/blah` export 才能运行（防止工具调用后 SDK 卡在等待 tool_result），**未在 trace 里看到证据**。

### 2.6 ❓ Pi 0.82 已知兼容性疑点
SDK 版本 `@earendil-works/pi-coding-agent`（4 个 nested 子包）。`_handleAgentEvent` 是 `async` 但其 promise 没有由 `_runAgentPrompt` `await`——SDK 内部用 promise chain 处理，若 emit 链异常可能换为「永远 not_resolved」的状态（unhandled rejection）。该疑点仅在 Forge 真实组合路径才能复现。

### 2.7 ❓ SessionManager.inMemory vs onDisk
Forge 用 `SessionManager.inMemory(cwd, {id})`。SDK session 持久化报错"SQLite experimental"警告（隔离测试时也出现）——不影响功能但说明 SDK 0.82 默认开了 SQLite 路径。

## 3. 已确认无问题

- `deepseek-v4-flash` 在 SDK ModelRuntime 解析 OK
- DEEPSEEK_API_KEY 通过 defaultAuthContext 读到（keyLen=35）
- DeepSeek direct API（绕过 SDK）正常返回（v4-flash 是 reasoning 模型）
- 隔离最小 SDK listener 测试（subscribe + prompt）843ms 完整跑通 14 个事件
- v2 framework 路径事件簿（task_started → agent_attempt_started_v2）正确发出
- capability eligibility 状态正常（digest 匹配，未阻塞）
- v1 capability 与 v1 任务不受影响（v2 turn 启动后才有问题）
- HTTP API/路由/v2 task 投影/map/summary/tree 端点全部正常返回

## 4. 推荐给接手 Agent 的下一步（按优先级）

1. **最快路径**——临时切换 agent model 为非推理模型，看是否恢复：
   ```bash
   # 编辑 templates/zhihu-salt-chapter-draft/agents/*.yaml
   # 把 4 个 agent model 由 deepseek/deepseek-v4-flash 改为 deepseek/deepseek-chat（验证发现 SDK 未注册该 id）
   # 或改为 openai/gpt-4o-mini（如果 SDK 内置 OpenAI provider），或改为 anthropic/claude-haiku-4-5（如果 SDK 内置 Anthropic provider）
   ```
   若切回非 reasoning 模型后 turn 正常，则锁定 #2.4 的根因——给 `Authorization: Bearer <key>` + reasoning 模型 + SDK 0.82 组合不兼容，需要 SDK 升级或换 v4-flash 的 `compat.requiresReasoningContentOnAssistantMessages` 实现。

2. **次快路径**——在 `pi-agent-runtime.ts:882` 创建 session 后、订阅前后注入超时（10-30s）：
   ```js
   setTimeout(() => session.abort(), 30000)
   ```
   让 Pi turn 主动 abort，若 turn 中止后 Runner 接 `RuntimeAbortedError` 走 attempt-coordinator 的 terminal/aborted 路径（spec §7.2），证明 turn 卡在哪一类等待。

3. **稳健路径**——给 SDK agent 事件加堆栈 + 时序 logger。在 `pi-agent-runtime.ts:925` 和 `pi-agent-runtime.ts:911` 两个 listener 里 `console.error('event', type, JSON.stringify(event).slice(0,200))`。重启 dev，看输出到哪个事件后不再有新事件。

4. **DeepSeek testing by deepseek-chat or openai provider**：先验证 #2.4 是真凶。如果非推理模型 OK，证明 SDK 0.82 与 reasoning 模型不兼容；如果非推理模型仍卡死，#2.5/#2.3/#2.6 是大嫌疑。

5. **环境修复**：升级 `@earendil-works/pi-coding-agent` 到最新版（验证 _handleAgentEvent signature change 与 issue list）；或者写一个 Forge `PiSessionFactory` 包装层（替换 SDK session 为自定义 session），把 listener 与工具调用改成单向 sync interface。

## 5. 不需要回头看的部分（已确认）

- ❌ v2 framework capability eligibility / digest 匹配
- ❌ event vault 持久化 / facade 跨进程锁（v2 capability disabled 期间没有任何 v2 task 跑通）
- ❌ template semantic hash 错位（v2 acceptance hermetic 测试全绿）
- ❌ projection fail closed 漏洞（已修）
- ❌ createSystemSealPublisher capability 不可伪造（已修）
- ❌ 发布 recipe 闭包校验（已修）
- ❌ 暂存竞态删除赢家（已修）
- ❌ seal gate 系统推导 + warning custody（已修）

## 6. 给接手 Agent 的命令模板

```bash
# 切非推理模型（先试最简单）
cd /Users/lzy/Desktop/ForgeCore/.worktrees/authoritative-slot-review-v2  # 如还有 worktree
# 在 templates/zhihu-salt-chapter-draft/agents/*.yaml 把 model 改成 deepseek/deepseek-chat（验证若 SDK 报错则改用 openai/gpt-4o-mini）

# 启 dev
env -i HOME=$HOME PATH=$PATH FORGE_CORE_DATA_ROOT=$PWD/data \
    FORGE_CORE_PORT=3210 VITE_FORGE_CORE_MODE=http \
    DEEPSEEK_API_KEY=sk-... npm run dev &

# 创建任务
curl -s -X POST http://127.0.0.1:3210/api/tasks -H 'Content-Type: application/json' \
  -d '{"templateId":"zhihu-salt-chapter-draft","name":"x","input":{"chapter_packet":"...","previous_draft":"","repair_order":""}}'
curl -s -X POST http://127.0.0.1:3210/api/tasks/<TID>/start
sleep 30
curl -s http://127.0.0.1:3210/api/tasks/<TID>/workspace | jq '.task.currentAgentName, .authoritativeReview.executionEligibility'

# 看事件
ls -t .worktrees/authoritative-slot-review-v2/data/tasks/<TID>/events/ | head -1 | xargs cat | jq '.events | map(.type)'

# 加 logger（详见步骤 3）
```

## 7. 已知未实现原因

> **本轮排查期间 API 套餐用尽，已停止 spawn sub-agent 进一步测试。** 这是一个独立的 SDK/provider 兼容性问题，与 Forge 业务代码无关。继续运行 dev 需要给 Anthropic API 配额补充后重新分发问题到其他 Agent。
