# Sugent 本地代码仓绑定、双向文件透传与端到端 Antigravity 定制开发流水线（M1–M4）

**Goal:** 将 Sugent（桌面端为主控制面 + 微信/飞书/钉钉/企业微信为移动社交代理入口）与本机 Antigravity 研发引擎深度绑定，打通「需求输入与附件透传 → 隔离 Worktree → Plan 拍板 → 编码自愈 → 宿主客观门禁 → 分级打包 → 蓝绿防改砖重启」完整闭环，同时面向未来 Claude Code / Codex 预留标准 `CodingHarnessPort` 适配接口。

**Architecture:** 执行面与代码仓驻留本机，坚决不做重型云容器；云端仅作为无状态 E2EE 薄信令/同步可选增值层（`mode: "none"` 离线全功能可用）。核心模块全部零侵入沉淀于 [`src/sugent/`](../../src/sugent/)，外部重启守护脚本独立为 [`scripts/safe-relaunch.mjs`](../../scripts/safe-relaunch.mjs)。

## 0. 商业策略自省四问（AGENTS.md 强制门禁）

动手写代码前，先对照 [`AGENTS.md`](../../AGENTS.md) 第 3 节完成四项门禁审查：

| 自省维度 | 核心拷问 | 本规划的架构落位与守线做法 |
| :--- | :--- | :--- |
| 1. 付费锚点 | 哪些属开源引流基座，哪些属商业增值？对比大厂办公套件优势在哪？ | 本地代码仓绑定、`.sugent-handoff/` 双向文件信箱、Antigravity 调度、`IndependentGateRunner` 客观门禁与 `safe-relaunch.mjs` 蓝绿重启全部开源引流；跨端 E2EE 手机实时控台与加密团队工作流模版作为 Pro/Team 商业增值。对比钉钉/企微云端办公套件，Sugent 守住“代码与本地 `.env`/账本不出本机”的隐私主权与跨生态中立性（Antigravity/CC/Codex 自由切换）。 |
| 2. 合规与分发 | 能否通过 macOS 公证、Windows 签名与平台风控审查？ | 只调官方 `agentapi` 参数数组与本机 `git` 参数数组，不探测未文档化端口、不直接写改签名只读 `app.asar`；L3 重打包统一在隔离 Worktree 生成 staging `.app` 后由外部看门狗原子替换并带 30s 自动回滚，零硬编码三方密钥。 |
| 3. 离线退路 | 剥离云端账号进入 `mode: "none"` 后，核心能力是否独立可用？ | 在 `mode: "none"` 下，桌面客户端、本地仓绑定、文件信箱透传、Antigravity 派单、客观门禁验证与蓝绿重启 100% 单机闭环运行，零云端强依赖。 |
| 4. 一人公司运维杠杆 | 能否做到零云端重状态服务器与低日常维护成本？ | 执行算力全在本机；等待拍板状态落盘 `SuspendedRoundStore`（0 轮询 Token）；无需维护任何云端 Docker/Mac Runner 集群。 |

## 1. 架构分层与文件透传协议（M1–M4）

```text
[全能桌面端 Sugent App (主控制面)] ◄──► [微信 / 飞书 / 钉钉 / 企业微信 (社交代理入口)]
                 │
                 ▼  (1. RepoBindingRegistry + GitWorktreeManager)
  <repoRoot>/.worktrees/<bindingId>/<taskId>/
                 │
                 ▼  (2. HandoffFileBridge: 自动写入 .git/info/exclude)
  .sugent-handoff/inbox/<roundId>/SPEC_MANIFEST.md + 附件(图片/文档/0400外部信封)
                 │
                 ▼  (3. CodingHarnessPort -> Antigravity / future CC & Codex)
  Phase 1 调研出 Plan -> SuspendedRoundStore 挂起等拍板 -> Phase 2 编码自测
                 │
                 ▼  (4. IndependentGateRunner 客观复核 + HandoffFileBridge 出站分级)
  typecheck / verify:sugent / AMB_ELECTRON_SMOKE -> .sugent-handoff/outbox/<roundId>/
                 │
                 ▼  (5. SafeRelaunchCoordinator + scripts/safe-relaunch.mjs)
  L1 热插拔 / L2 源码重启 / L3 蓝绿替换 (.last-good 备份 + 30s boot-healthy 看门狗回滚)
```

## 2. 里程碑拆分与验收标准

| 里程碑 | 核心模块 | 验收判据 |
| :--- | :--- | :--- |
| M1 | `src/sugent/antigravity-dispatcher.ts` (`cwd`)、`src/sugent/repo-binding.ts` | 支持 Sugent 自举仓预设与任意本地仓绑定、Worktree 隔离、兼容 Worktree `.git` 文件的 `info/exclude` 注入、`CodingHarnessPort` 抽象 |
| M1.5 | `src/sugent/handoff-file-bridge.ts` | 入站文件净化/拉取安全边界/外部转发 `0400` 隔离信封、`SPEC_MANIFEST.md` 生成、出站符号链接逃逸拦截与 IM 10MB/图数分级透传 |
| M2 | `src/sugent/vibe-coding-pipeline.ts`、`steward-host-service.ts`、`steward-conversation.ts`、`steward-llm-agent.ts` | 完整 8 态流水线（调研 Plan → 挂起拍板 → 改代码 → 客观门禁失败自动打回自愈 → 通过出图 → 打包/重启拍板），支持桌面端与多 IM 入口 |
| M3 | `src/sugent/safe-relauncher.ts`、`scripts/safe-relaunch.mjs`、`electron/main.ts` | 独立看门狗进程真实验证：健康新包写 `boot-healthy.json` 即完成切换；崩溃或超时新包自动杀进程并恢复 `.last-good` 重启 |
| M4 | `src/app.ts`、`src/web/server.ts`、`ui/components/jarvis-workbench.js` | 全能桌面端「定制开发与本地代码仓」看板 + `/amb/api/steward/repos` & `/vibe/*` 路由 + IM 出站回执/文件推送 |
