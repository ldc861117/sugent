# Sugent 安装与端-边动态联邦自引导指南 (Agent-First INSTALL)

本文档面向开发者与各类本地 Coding Agent（Claude Code、Codex、Gemini CLI、Cursor 等）。你可以直接将本文档交给你的 Agent，自动完成环境检查、自引导试跑与团队联邦挂载。

## 1. 环境前置要求

- **Node.js**：`>= 22.13`
- **操作系统**：macOS（Apple Silicon / Intel）、Linux（x64 / arm64）或 Windows 10/11

## 2. 三步安装与自检（零外部密钥可跑通）

```bash
# 1. 安装依赖
npm install

# 2. 运行全套类型检查、构建、零依赖契约门禁与文档门禁
npm run verify:sugent

# 3. 运行 1 秒零 Token 全链路体验（安全信封隔离 -> 挂起零消耗存档 -> 拍板恢复 -> 因果时间线）
npm run sugent:try
```

## 3. 常用运维与排障命令

- **首次交互配置向导（网关密钥 / 飞书机器人）**：`npm run init`
- **启动本地控制台与后台宿主**：`npm start`
- **反查任意一轮任务因果链（`sugent why`）**：
  ```bash
  npm run sugent:why -- --list
  npm run sugent:why -- <roundId>
  ```
- **运行 Sugent 核心测试套件**：`npm run test:sugent`

## 4. 可选：动态挂载 `Business-Level Cowork` 团队母舰

当你需要让某个工作 Bot 接入团队的 `business-level-cowork` 平台（默认端口 `28080`），同时保持私人 Bot 本地记忆物理隔离时：

1. 在 `business-level-cowork` 仓库按员工工号生成专属最小权限联邦配置：
   ```bash
   python3 client/generate_config.py --target sugent --user-id USR-EXPERT-01 --workspace-id ws-team
   ```
2. 将生成的 `client/sugent_federation_config.json` 交给 `src/sugent/cowork-bridge.ts` 中的 `parseCoworkFederationProfile()`：
   - 工作 Bot 自动经 `@deepseek-ai/dsh-mcp-client` 挂载远程 `/sse` 5 大本体工具，并将推理流量路由至 `/v1` 审计网关；
   - 来自 Staging 缓冲池的 `PENDING_REVIEW` 待审事件经 `ingestCoworkPendingEvent()` 自动写入只读 `.context/event-<id>.md` 安全信封，仅允许 `expert` / `admin` 角色执行移动 HITL 拍板回调。
