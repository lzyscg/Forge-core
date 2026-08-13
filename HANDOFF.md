# Forge Core 当前交接说明

> 本文件替代旧的“平台补强 + outline-designer 分支”交接稿。它描述当前 `main` 如何继续开发；历史 Phase 记录仍在 `docs/IMPLEMENTATION-LOG.md`。

## 当前状态

- 当前工作分支：`main`；本地仓库应保持单一干净 worktree。
- 结构槽模式：`structured_slots` 已实现并接入生产 capability；当前业务模板为 `templates/zhihu-salt-chapter-draft/`。
- 结构槽生产 acceptance：必须同时验证 injected 和 production；生产 capability 的证据是源码摘要绑定的，不应在任何源文件变化后直接复用旧证据。
- basic 模式与九个 ForgeAction：继续作为兼容基线，不得为结构槽模板特化或删减。
- 真实知乎 Skill 已放在根目录 `skills/`；模板只绑定自己需要的 Skill，不把全部业务 Skill 编译进平台。

## 当前运行入口

```bash
FORGE_CORE_DATA_ROOT=$PWD/data \
FORGE_CORE_PORT=3210 \
VITE_FORGE_CORE_MODE=http \
npm run dev
```

浏览器先打开 `/tasks`，再进入任务详情。结构槽离线验收：

```bash
npm run verify:structured-slots -- --acceptance-only --capability injected
npm run verify:structured-slots -- --acceptance-only --capability production
```

普通改动：

```bash
npm run check
npm test -- --reporter=dot
npm run build
npm run e2e
```

## 结构槽模板边界

`zhihu-salt-chapter-draft` 只产出一章 `chapter.md`，运行链是：

```text
structure -> fill -> seal -> submitter
```

槽位合同是：

```text
chapter:
  title
  opening
  scene_block*
  emotional_closure
  chapter_end
```

章节执行包、大纲、审核账本、全文总控和最终交付证书不属于这个模板。后续应按“一个模板一个工件”分别建设，再通过合法 artifact/message route 组合。

## 继续开发时的检查顺序

1. `README.md`、`docs/ONBOARDING-context.md`、`docs/ARCHITECTURE.md`、`docs/PROJECT-MAP.md`。
2. 相关权威设计/规格；确认不是历史草案。
3. `src/shared` 契约和 `src/server/template` 的模板编译边界。
4. 结构槽领域层、storage batch/blob/private state、runtime structured-slot 和 scheduler。
5. 模板 acceptance、focused tests、全量门禁、生产 acceptance。

任何修改都要记录：

- 实际 HEAD 和分支；
- 修改的契约/状态机/权限边界；
- 成功、失败、重复、崩溃恢复和资源超限测试；
- 若影响结构槽源码，重新生成 benchmark/profile/release/capability evidence；
- 未解决问题和是否阻断 production promotion。

## 不要做的事

- 不要手工把 `runtime-capability-v1.json` 改成 enabled。
- 不要通过放宽 frozen bounds、删除 benchmark case、伪造 evidence 或跳过 production acceptance 来“过门禁”。
- 不要把所有知乎 Skill 和故事业务词放进平台层。
- 不要用一个“大模板”吞掉章节包、大纲、正文和全文审核；先保持工件边界。
- 不要把 `.env`、API key、`data/`、运行日志和临时 evidence 作为普通源文件提交。

## 新 Agent 的最短路径

```text
README.md
  -> docs/ONBOARDING-context.md
  -> docs/ARCHITECTURE.md
  -> docs/PROJECT-MAP.md
  -> templates/zhihu-salt-chapter-draft/
  -> src/server/runtime/structured-slot/
```

完成开发后，不要只报告“代码写完”或“测试绿色”。请给出当前 commit、测试命令与计数、结构槽 qualification/promotion 状态、实际生产 acceptance 和剩余边界。
