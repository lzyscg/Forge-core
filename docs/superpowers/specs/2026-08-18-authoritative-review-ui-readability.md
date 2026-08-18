# Authoritative v2 过程与审核详情可读性设计

日期：2026-08-18

## 背景

真实 v2 生产已经通过权威事件、WorkItem、Attempt、Map、内容 Manifest 和 Seal 链完成，但生产页仍只把旧版 `WorkspaceNode` 投影到画布。v2 任务没有旧版节点，因此页面显示四个空泳道；审核抽屉虽然调用了 v2 只读 API，却只展示状态短词，固定网格又把长 ID、Finding 字段和 Gate 文案挤在一起。

## 目标

1. 生产页在 v2 任务上显示来自权威投影的真实过程：每个 WorkItem 的阶段、Agent/系统角色、session、尝试次数、当前/失败/重试状态和 WorkItem ID。
2. 槽位树选中一个槽位后展示真实内容版本、正文预览、内容摘要、Map/内容审核状态和 blocking Finding；没有内容时明确显示原因，不用空白或推断填充。
3. Findings、Seal 和槽位树在桌面与窄屏下都使用可换行的卡片/定义列表，长 ID 可读且不发生横向覆盖。
4. 保持 v2 权威门禁不变：页面只读，状态和 Seal 仍由服务器投影决定。

## 用户可见契约

### v2 过程

`TaskWorkspace.authoritativeReview.activity` 是公开的展示投影，不是新的门禁状态。它只包含：

- WorkItem ID、WorkItem kind、角色绑定、session kind；
- `queued`、`running`、`retrying`、`completed`、`failed`、`parked`、`superseded` 展示状态；
- 尝试次数、最近一次 Attempt 状态、稳定失败码和重试时间。

它由 `AuthoritativeReviewProjectionV2.workItems/attempts/activeLease` 派生，不能由前端根据模板路由或旧版节点猜测。页面将角色绑定映射为冻结 Agent 名称；系统 WorkItem 明确标为“系统”。

### 槽位内容

`AuthoritativeSlotReviewDetailV2.contentDetail` 绑定当前只读 snapshot 的：

`currentManifest → manifest.entries[slotId] → content_version → content_value`

返回版本状态、版本号、内容 digest、媒体类型、文本长度和有限正文预览。正文超过展示上限时带 `truncated` 标记；`unset`/`rewrite_required` 显示状态，不伪造正文。该字段只读，不暴露 Grant、私有 attempt 输出或 provider 信息。

### 布局

- 主生产画布：v2 显示“权威生产过程”时间线；v1/basic 保持现有 WorkspaceCanvas。
- 槽位树：行内使用可收缩的 ID/类型/状态徽章，点击整行加载详情；详情区使用分组卡片和正文滚动框。
- Findings：每个 Finding 一张卡，字段采用标签/值布局，定位动作保持可用。
- Seal：每个 Gate 一张可换行的条件卡，状态使用文字和徽章；引用显示为带 title 的短标签。
- 抽屉宽度扩大但受 viewport 限制，窄屏时字段自动堆叠；不依赖固定的多列宽度。

## 数据流

```text
v2 event ledger
  -> AuthoritativeReviewProjectionV2
  -> TaskWorkspace.authoritativeReview.activity
  -> AuthoritativeProcessPanel

v2 projection + current manifest/blob chain
  -> AuthoritativeSlotReviewDetailV2.contentDetail
  -> VirtualReviewTree selected-slot detail
```

`TaskWorkspace` 的既有 `updatedAt`/watch 机制继续触发过程刷新；不增加另一套客户端计时器，也不从日志文本解析过程。

## 失败与兼容

- 无法解析 v2 历史时，现有 task diagnostic/status 仍按原契约返回；activity 不做部分猜测。
- 当前 Manifest 缺失时槽位详情的 `contentDetail` 为 null，并显示“当前没有可读内容版本”。
- v1/basic 任务不生成 activity，不改变现有画布和接口兼容性。
- 内容正文只读、限长；Gate/Review 结论不因 UI 展示改变。

## 验证

- projection-service 单测覆盖 `contentDetail` 的 set/unset 和正文截断。
- workspace/API 单测覆盖 activity 派生和 schema 解码。
- React 单测覆盖 v2 过程渲染、槽位详情、Finding/Seal 卡片不重叠的语义字段。
- 使用真实服务和浏览器打开已有 v2 任务，确认过程、槽位正文、Findings、Seal 四个页面均可读，控制台无新增错误；再以 API 证据确认 task status、review summary 和 seal readiness 仍真实一致。
