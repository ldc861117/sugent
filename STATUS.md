---
status_version: 1
project: sugent
review_state: pending_review
updated_by: gemini-task@local-mac
updated_at: "2026-11-25T21:10:00-08:00"
confirmed_by: ""
confirmed_at: ""
---

## 阶段目标

一比一对齐 Ops 看板纳管发现、六态分栏与双源状态同步

## 最近完成

- **Ops 看板 2.0 抓取与分栏逻辑 1:1 对齐（26 项新增/更新单测与第 1–27 节门禁全绿）**：
  - 纳管白名单过滤（`src/sugent/edge-tentacle-hub.ts`）：按 `agy-fleet-config` 规范仅纳管已注册项目配置、活跃会话工作区、显式 `STATUS.md`/`.ops-project.json` 及核心常驻目录，将 `Projects/` 下未触碰的第三方克隆仓库归入休眠目录，消除 38 个克隆仓库混入看板与字母序 40 上限截断问题。
  - 双语法路线图与六态分栏对齐：完整移植 `[x]/[/]` 与 `✅/🚧` + `H0.1`/`P0.1` 交付物编号解析及 `Exit / Profit Gate` 门禁识别（如 `airtoken` 识别为 `monitoring` 常驻观测），严格对齐 `blocked` / `pending_review` / `active_executing` / `monitoring` / `planned_ready` / `idle_untracked` 六态与 72 小时在途过期降级。
  - `Andy-web` `/ops` 桥接契约与幕僚汇报语义修正（`src/sugent/ops-bridge-client.ts`、`src/sugent/steward-host-service.ts`、`src/sugent/steward-llm-agent.ts`）：对齐 `nodeToken` / `bridgeJwt` 鉴权字段与 `user_override` 手动覆盖优先级，`manage_ops_fleet` 严格区分 `runningNow`（真正执行中）与 `totalManaged`（总纳管），默认折叠 `idle_untracked` 与 `archived`。
  - 边缘触手常驻定时器修复（`src/cli/edge-tentacle.ts`、`deploy/edge-tentacle/ai.sugent.edge-tentacle.plist`）：修复守护模式常驻循环与代理环境变量透传。
- **云端唯一大脑、`sugent.metamirror.club` HTTPS 反代与跨天全渠道记忆召回闭环（`cd88d11`）**。

## 在途

- 待主人执行一键同步脚本：刷新本机 `local-mac` 触手脉冲、推送代码更新云端 `sugent-gce-hub` 镜像，并为云端中枢挂载 `OPS_BASE_URL=https://andylyu.com` 与 `/opt/airtoken` 节点脉冲。

## 下一步

1. 运行下方一键同步命令，立即清洗本机脉冲并升级 GCE `sugent-gce-hub` 容器。
2. 在微信向 ClawBot 发送“现在有哪些在运行项目？airtoken 状态如何？”验证与 `https://andylyu.com/ops` 完全一致。

## 卡点

- 暂无阻塞卡点；全量 Vitest 单测与 `npm run verify:sugent`（第 1–27 节 + `docs:check`）全部通过。
