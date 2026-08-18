# Plan: 修复 authoritative v2 生产过程与审核详情页面

> **执行说明：** 按 TDD 执行；每个任务先写一个会失败的测试，确认失败原因，再写最小实现并回归。

## 目标

让真实 v2 任务在生产页显示权威 WorkItem 过程，在审核抽屉显示槽位正文与完整审核事实，并修复长字段布局覆盖。

## 文件范围

- 共享契约与 schema：`src/shared/authoritative-review-v2.ts`、`src/shared/contracts.ts`、`src/shared/api-schemas.ts`
- v2 只读投影：`src/server/runtime/authoritative-review/projection-service.ts`、`src/server/core-service.ts`
- v2 workspace 投影：`src/server/core-service.ts`
- 前端过程/审核 UI：`src/client/components/authoritative-process-panel.tsx`、`src/client/components/structured-review/virtual-review-tree.tsx`、`findings-view.tsx`、`seal-readiness-view.tsx`、`src/client/pages/production-page.tsx`
- 样式：`src/client/styles/app.css`
- 回归测试：对应 projection/API/React 测试文件

## 任务 1：锁定共享 v2 展示契约

1. 在共享类型中增加 activity step、activity summary 和 slot content detail DTO。
2. 给 `authoritativeReviewWorkspaceV2Schema` 与 `authoritativeSlotReviewDetailV2Schema` 增加严格字段。
3. 补 schema/contract 测试，证明旧 v1/basic workspace 仍可解码，v2 新字段能通过校验。
4. 运行目标测试并确认新测试先因缺少字段/实现失败。

## 任务 2：实现权威 activity 投影

1. 在 `projectTask` 中从 v2 projection 的 workItems、attempts、activeLease 派生公开 activity，不读取私有运行时缓存。
2. 将 WorkItem 内部状态映射为稳定的展示状态，保留失败码/重试时间等可诊断但不含 provider 输出的字段。
3. 将 activity 放入 v2 workspace，并更新 workspace digest 覆盖 activity 变化。
4. 添加 API integration 回归：真实投影含结构阶段、内容阶段、审核阶段和系统 Seal/settlement 时，返回的 activity 顺序、状态和计数可验证。

## 任务 3：实现槽位内容详情投影

1. 在 projection-service 的 slot detail 读取当前 Manifest 与对应 content version/value。
2. 只返回公开的版本/摘要/媒体/限长正文字段；无 Manifest、unset、rewrite_required 分支显式返回状态。
3. 添加 projection-service 测试覆盖 set 内容、unset 内容、长正文截断、错误槽位仍为 `SLOT_NOT_VISIBLE`。
4. 运行目标测试，确保读取是按选中槽位触发的有限 blob 读取，而不是树列表 N+1。

## 任务 4：重做前端 v2 过程和槽位树详情

1. 新增 `AuthoritativeProcessPanel`，按 activity 渲染阶段时间线、状态文本、Agent/系统标签、attempt 和可读 ID。
2. v2 生产页显示该 panel；v1/basic 继续显示 WorkspaceCanvas。
3. 槽位树支持整行选择，详情区显示槽位元数据、实际正文预览、版本 digest、Map/内容审核状态和 Findings。
4. React 测试先锁定 v2 completed/running/error 三类状态和正文/无正文显示。

## 任务 5：修复 Findings、Seal 和抽屉布局

1. Findings 改成标签/值卡片，显示真实 `source` 而不是硬编码 owner，保留定位。
2. Seal Gate 改成可换行卡片，长 detail 和引用不覆盖；保留通过/未满足文字。
3. 槽位树/详情使用 `minmax(0,...)`、`overflow-wrap:anywhere` 和窄屏堆叠；扩大 review drawer 的最大宽度并限制 viewport。
4. 更新 React/CSS 语义测试，确认 Finding ID、Gate code、slot content 都可见。

## 任务 6：构建、服务与真实浏览器验收

1. 运行 `npm run check`、目标 Vitest、`npm run build`。
2. 重启真实服务并确认 `/api/health`、v2 workspace/activity、slot review/content detail API。
3. 用浏览器打开实际 v2 task：确认过程时间线、槽位正文、Findings、Seal 的布局和交互；确认 console 无新增 error。
4. 若发现真实页面仍空白、覆盖或 API/schema 不一致，回到对应任务补测试后修复，再重复验收。

## 完成标准

- v2 页面不再依赖空的旧版 nodes 才能显示过程。
- 选中槽位能看到真实内容版本和正文（或明确的无正文状态）。
- 截图中的 ID、Finding、Seal 字段不再互相覆盖，桌面/窄屏均可读。
- 自动化测试、TypeScript/build、真实 HTTP 和真实浏览器证据全部通过。
