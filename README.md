# Forge Core（独立项目）

从 `Forge_AI` monorepo 隔离出的 Forge Core 本地产品线：单进程文件后端 + 受约束 Pi Agent Runtime + 五页 UI。多 Agent 协作内容生产：写作 Agent 起草 → 审核 Agent 退回返修 → 复审确认 → 系统独立交付。

## 安装

```bash
npm install
npx playwright install chromium   # 浏览器门禁
cp .env.example .env              # 填入 DEEPSEEK_API_KEY（真实运行必需）
```

Node >= 22.19。

## 运行

真实后端（HTTP 模式，读本地文件）：

```bash
FORGE_CORE_DATA_ROOT=$PWD/data \
FORGE_CORE_TEMPLATE_ROOT=$PWD/templates \
FORGE_CORE_PORT=3210 VITE_FORGE_CORE_MODE=http \
npm run dev
# 打开 http://127.0.0.1:3210
```

Mock 演示（零 token）：

```bash
npm run dev:client -- --port 3211
# 打开 http://127.0.0.1:3211
```

## 测试 / 门禁

```bash
npm run check        # tsc --noEmit
npm test             # vitest
npm run build        # vite build + server tsc
npm run e2e          # Playwright
npm run verify:ui    # UI 门禁
npm run verify:backend
npm run verify:runtime
npm run probe:pi -- --provider deepseek --model deepseek-v4-flash --report /tmp/pi-boundary.json
```

## 目录

- `src/client` 五页 UI + 回合卡/流式预览/删除
- `src/server` 文件后端 + Pi Agent Runtime + 调度/重试/恢复
- `templates/` 知乎单章模板（Agent/Skill/管道）
