# Forge Core 产物版本目录制 — 实施日志

> 整晚自主开发日志。按 dev-plan 8 Phase 推进,每 Phase TDD + 全绿 + 本地 commit。
> 设计基准：v7 定稿（`docs/2026-08-06-artifact-version-directory.md`）。

## 总体策略与关键决策

- **起步状态**：`main` 上模板被脏改为真实模型名（违反 `configured/*` 占位符协议），已 `git checkout templates/` 恢复为提交的占位符状态。提交模板必须保持 `configured/*`，真实验收才在工作副本替换标量（参考 `scripts/real-acceptance.ts`）。
- **Phase 0 连锁处理**：v2 契约把 `artifactVersion→inputVersion`、`ArtifactVersion.content→files[]`。这些字段被 ~30 个文件、84 处引用消费。为满足「每 Phase 全绿才 commit」，Phase 0 做一次全局机械 rename + 过渡行为修正，所有 consumer 与其测试同步更新；行为保持过渡态（单 content 文件、inputVersion 传播尚未接通），真正多文件/事件权威版本号在 Phase 1，传播在 Phase 4。
- **legacy 兼容**：v1 在途任务 gate 为 `incompatible(SCHEMA_V2_REQUIRED)` 只读；event-store 读取期 transform 归一旧事件（artifactVersion→inputVersion、contentHash→files、缺省 humanAuthorized=false、缺省 source=agent_request）使其不 CORRUPTED。
- **真实验收**：`scripts/real-acceptance.ts` 硬编码 zhihu-single-chapter（Phase 3 删除）。Phase 7 将写 dedicated long-form-hub 验收脚本（3 agent：controller/writer/reviewer 占位符替换）。

## Phase 1 — 存储层

（已完成；tsc 0 错误，1093/1093 测试绿，含新增 14 条 artifact-store v7 测试）

### 做了什么
- `src/server/storage/artifact-store.ts` 全面重写为 v7 事件权威版本目录存储：
  - **注入 EventStore**（构造 `new ArtifactStore(paths, events)`），无循环依赖。
  - **版本号=已提交 artifact_published 事件数+1**（不再 max-dir+1）。
  - **多文件**：`ArtifactProposal.files:[{name,content}]`；版本目录含 content.md/revision.md/review.md + meta.json。
  - **meta 无文件哈希**（spec §3.1）：`ArtifactMeta={id,version,title,sourceNodeId,format,createdAt}`；哈希在事件。
  - **annotate**：`annotate(taskId, {version,file,content,turnId,nodeId})` 原子 staging→rename 追加文件；唯一性扫 artifact_annotated 事件，**重放自排除**（同 nodeId 幂等），不同 turn 拒绝。
  - **盘↔事件交叉校验**：read/list 校验生产文件 hash 对 artifact_published.files[].hash、标注文件对 artifact_annotated.contentHash；不一致 TASK_CORRUPTED。
  - **读窗口容忍**「事件在、目录无」：claimStagedVersion 扫 `.tmp-vNNN-*`，artifactId 优先/contentHash 退回，rename 落位。
  - **孤儿 final 目录**（dir 在、事件无）：list 不列出，下次 publish 同版本按 hash 认领或冲突判 CORRUPTED。
  - `readFile(taskId,version,file)` 供 read_artifact_version 工具。
  - 新类型 `PublishedArtifact`/`AnnotatedFile`/`ArtifactEntry{meta,files}`/`AnnotateProposal`。
- 消费方更新：`core-service` 构造注入 events；`publishTestArtifact` 改 files + **先写事件再 read**（cross-check 要求事件在场）；`action-committer.publishSealedPackage` 传 files + 事件 files 用 store 结果；`task-runner` handOff 从 `files.find(content.md/txt)` 取正文；`task-projector` 映射多文件 + `extractForFile`（review/revision/content）；api-schemas 不变（已 v7）。
- `scripts/real-recovery-acceptance.ts`：reconcile 改为对比 disk 内容 hash 与**事件** hash（meta 不再带 contentHash）。
- 新增 `artifact-store.test.ts` 14 例（重写）：publish 版本计数/meta 无哈希/多文件/校验、annotate 唯一性+自排除+幂等、cross-check fail-loud、staging 认领、孤儿 final 认领、re-publish 冲突。

### 关键决策
- **publishTestArtifact 顺序**：必须 publish→append 事件→read（cross-check 需事件在场），原顺序 publish→read→append 会触发 "无发布事件" CORRUPTED。
- **committer publish 不受 cross-check 影响**：committer 的首次 publish 不调 read（只 replay 分支调，此时事件已存在），故无顺序问题。
- **孤儿目录策略**：list 只列事件背书的版本；孤儿 final 由下次 publish 同版本按 hash 认领（内容一致复用 id，不一致 CORRUPTED）。这是对「事件流是唯一权威」的忠实落地。

### 问题与解决
- recovery 集成测试在并行满载下偶发 timing race（empty-action 中性 turn 的 attempt failure vs fetch 竞态）；隔离运行稳定通过，非真实回归。
- real-recovery reconcile 误用 meta.contentHash（已不存在）→ 改读事件 files[0].hash 为权威。
- perl `s/...$//` 误截断测试文件 → 重写恢复。

## Phase 0 — 事件契约与数据模型

（已完成；tsc 0 错误，1086/1086 测试绿，含新增 26 条 task-events 测试）

### 做了什么
- `src/server/storage/task-events.ts` 重写为 v7 联合：
  - 新成员 `artifact_annotated {version,file,contentHash,turnId,nodeId}`、`pending_inputs_superseded {supersededNodeIds[]}`。
  - `artifact_published.artifact`：`contentHash` → `files:[{name,hash}]` + `artifactType` + `artifactId`（均 `string|null`，legacy transform 归一为 null）。
  - `agent_result` 增可选 `inputNodeId`/`dispatchKind`（publish/forward/send/submit/human），条件包含以保 round-trip 字节一致。
  - `EventNode.artifactVersion` → `inputVersion`；新增可选 `humanAuthorized`。
  - `task_incompatible.reason` 增 `SCHEMA_V2_REQUIRED`。
  - `human_requested` 增可选 `source`（progress_guard|agent_request）。
  - 导出 `normalizeLegacyEvent`：读取期归一 v1 事件（artifactVersion→inputVersion、contentHash→files[按 format 选 content.md/txt]、artifactType/artifactId→null），不动 v7 事件。
- `src/server/storage/event-store.ts`：`readCommittedFile` 在 `validateTaskEvent` 前跑 `normalizeLegacyEvent`。
- `src/shared/contracts.ts`：`WorkspaceNode.artifactVersion`→`inputVersion` + `humanAuthorized?`；`ArtifactVersion.content`→`files: ArtifactFile[]`（新 `ArtifactFile{name,extract,content}`）。
- `src/shared/api-schemas.ts`：wire schema `artifactVersionSchema` 改 `files[]`（sed 误改的名 `inputVersionSchema` 已正名为 `artifactVersionSchema`）；`workspaceNodeSchema.inputVersion`。
- 全局机械 rename `artifactVersion`→`inputVersion`（src/ + scripts/，排除 task-events.ts 的 legacy 引用）。
- 消费方过渡适配（单文件 `content` extract 槽）：`artifact-store.publish` 返回 `files`；`task-projector` 映射 `files` + `incompatibleDiagnosticFor(SCHEMA_V2_REQUIRED)`；`action-committer`/`core-service` 的 `artifact_published` 事件构造改 `files[]`；mock/projector/UI/acceptance 脚本同步（client 子代理批量修复）。
- 新增 `src/server/storage/task-events.test.ts`（26 例）：新成员 fail-closed、files[] 校验、agent_result 可选字段、inputVersion/humanAuthorized、incompatible reason、human source、legacy transform 各分支。

### 关键决策
- `agent_result.inputNodeId/dispatchKind` 设为**可选**（条件包含）而非必填：让 minimal 测试构建器与 legacy 事件 round-trip 字节不变（canonical 比较稳定），committer 在 Phase 4 始终写入。读取侧 `?? null`。
- `EventArtifact.artifactType/artifactId` 为 `string|null`：新事件 committer 必填，legacy transform 归一 null。
- 保留单文件过渡：每个 `ArtifactVersion` 一律一个 `{name:'content.md',extract:'content',content}` 槽；多文件渲染留 Phase 6，事件权威版本号/staging 认领留 Phase 1。

### 问题与解决
- client 子代理修复 `src/client/**` 的 content→files 与 http-gateway cast；剩余 shared schema 缺口（api-schemas 仍校验 content）由我补齐。
- sed 把 acceptance 报告键 `artifactVersions` 误改为 `inputVersions`（`artifactVersion` 子串匹配），已正名回 `artifactVersions`。
- `StorageError.message` 是中文、`.code` 在属性上——reject 断言用 `expectInvalid` 检 `.code` 而非正则。

