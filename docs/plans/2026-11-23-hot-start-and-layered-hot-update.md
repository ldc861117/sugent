# Sugent 极速热启动与 L0–L3 分层热更新架构方案

> **Goal:** 在不破坏 macOS/Windows 安装包签名、不丢失 SQLite / 渠道连接状态、不重构打包链的前提下，打通 Sugent 的四级极速热启与热更新闭环：L0 扩展零重启热载、L1 前端零刷新/瞬时热更新、L2 壳核分离 1–3 秒内核热切、L3 外置签名 A/B 增量更新槽与自动回滚。

---

## Pre-Plan Commercial Reflection Gate（商业策略自省四问）

1. **付费锚点（Why Pay & Moat）**：桌面端「改完即生效」的零摩擦自演化能力 + 正式版 **3 秒免重装增量热更**，大幅强化了 Sugent 商业版作为个人数字幕僚与行业武器包载体（Prompt/Skill/Rule/逻辑热下发）的交付敏捷性；用户无需像传统 Electron 客户端那样等待数百 MB 安装包重下并中断桌面工作流。
2. **合规与分发（Distribution & ToS Risk）**：**只读签名外壳（`Sugent.app` / `app.asar`）一字节不改**，彻底避免破坏 macOS 公证签名与 Gatekeeper 拦截；L3 外置增量包严格限定纯 JS/UI 资源，采用 **Ed25519 非对称签名 + 每文件 SHA-256 校验 + `minShellAbiVersion` ABI 门禁**，拒绝任何越界路径（Zip-Slip）与不兼容壳版本加载。
3. **离线退路（Sovereignty Fallback）**：100% 保留 `mode: "none"` 免登录离线主权模式；本地开发/自改模式支持 `--allow-unsigned` 或本地私钥自签热包；任意外置槽出现启动异常时 **1 秒自动回滚上一健康槽**，并保留 `resetToFactoryGolden()` 一键退回原厂黄金镜像。
4. **一人公司运维杠杆（OPC Ops Leverage）**：无后端更新集群需求；单人架构师仅需一条 `npm run bundle:hot` 产出数百 KB～数 MB 的 `.sgbundle.gz` 离线/静态热更包（仅在 Electron / `magpie` 二进制变更时才走 `electron-updater` 整包更新）。

---

## Architecture Overview（L0–L3 四级分层热生效体系）

| 层级 | 触发与改动范围 | 生效耗时 | 核心机制 |
| :--- | :--- | :--- | :--- |
| **L0** | `SKILL.md`、动态插件 `<dataDir>/self-repo/extensions/plugins/*.mjs`、策略清单 | `< 200ms` | `HotReloadBus.reloadExtensions()` + ESM `?v=mtime` 破缓存动态重挂载 |
| **L1** | `ui/**/*.js`、`ui/**/*.css`、`ui/locales/**` | `< 300ms` | `HotReloadBus` 监听 UI 变更并通过 `/amb/api/hot-reload/stream` SSE 推送：CSS 原位热换 `<link>` 零闪屏，JS 自动轻刷页面 |
| **L2** | `src/sugent/*.ts`、`src/app.ts`、`src/web/**`（开发者热开发 & Vibe Coding 自改） | `1–3s` | **Thin Electron Shell + `HotCoreSupervisor`**：`tsc --incremental` 先编译；旧 Core 优雅 Drain 释放 `anymodel.lock`；新 Core 启动并 `healthz` 探活后，`win` 与 `companion` 原位无感重载 |
| **L3** | 已安装打包版 `Sugent.app` 的 `dist/ + ui/` 增量更新 | `3–8s` | **A/B 增量槽位（`<dataDir>/bundles/slot-{a,b}`）**：Ed25519 + SHA-256 校验解包至闲置槽 -> 触发 L2 热切 -> `/amb/healthz` 通过才 `commitPendingSlot()`；异常秒级自动回滚 |

---

## Global Invariants & Pitfalls Guard

1. **`anymodel.lock` 单宿主锁不变量**：必须先等待旧 Core 完成 `core:drain` 退出（超时强杀兜底）再拉起新 Core，避免双进程抢锁或双连微信/飞书。
2. **测试零监听器泄漏**：`HotReloadBus` 在 `VITEST` 环境下默认关闭持久 `fs.watch`（仅显式 `enableWatchers: true` 时启用），且在 `App.stop()` 中统一销毁所有 Watcher 与 SSE 连接。
3. **KnowledgeGraph 与 i18n 契约**：严禁在热更新初始化时向 `SugentKnowledgeGraph` 写入节点；所有新增 UI / Tray 文案同步写入中英双语词典并通过 `test/i18n.unit.test.ts`。

---

## Module & File Map

- **Create**:
  - `src/sugent/hot-bundle-slots.ts` — L3 `.sgbundle.gz` 构建、Ed25519 签名、SHA-256 与 Zip-Slip 安全校验、A/B 槽位状态机（`stage / commit / rollback / factoryReset`）。
  - `src/sugent/hot-reload-bus.ts` — L0/L1 SSE 广播总线、防抖目录监听、ESM 插件热加载与优雅卸载。
  - `src/sugent/hot-core-entry.ts` — 受管子进程 Core 入口（`App` 生命周期 + Node IPC `DesktopHooks` 代理）。
  - `src/sugent/hot-core-supervisor.ts` — 跨 Electron / CLI 复用的 Core 监督器（增量编译前置、优雅 Drain、健康检查、A/B 自动提交/回滚）。
  - `scripts/pack-hot-bundle.mjs` — 一键打包签名的 L3 增量包工具（`npm run bundle:hot`）。
  - `scripts/dev-hot.mjs` — `src/` 增量编译 + L1 UI / L2 Core 自动热更新开发运行器（`npm run dev:hot`）。
  - `ui/lib/hot-reload.js` — 前端 SSE 热刷新客户端（CSS 原位热替换 + JS/Core `bootId` 变化重载）。
  - `test/sugent-hot-bundle-slots.unit.test.ts` & `test/sugent-hot-reload-and-supervisor.e2e.unit.test.ts`。
- **Modify**:
  - `tsconfig.build.json`（开启 `--incremental`）、`package.json`（新增 `dev:hot`、`electron:hot`、`bundle:hot` 及新单测）、`scripts/write-build-manifest.mjs`、`scripts/verify-sugent.mjs`（第 22 节）。
  - `src/sugent/index.ts`、`src/app.ts`、`src/web/server.ts`、`src/sugent/steward-host-service.ts`、`src/sugent/steward-llm-agent.ts`、`src/sugent/vibe-coding-pipeline.ts`。
  - `electron/main.ts`、`electron/sugent-companion.ts`、`src/i18n/messages/desktop.ts`。
  - `ui/main.js`、`ui/companion.js`、`ui/components/jarvis-workbench.js`、`ui/locales/zh-CN/steward.js`、`ui/locales/en/steward.js`。

## Verification Gates

- `npm run typecheck < /dev/null`
- `npm run test:sugent < /dev/null`
- `npm run verify:sugent < /dev/null`（含 `typecheck` + `build` + 1–22 节契约 + `docs:check`）
- `npx vitest run test/i18n.unit.test.ts < /dev/null`
