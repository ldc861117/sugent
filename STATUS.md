---
status_version: 1
project: sugent
review_state: pending_review
updated_by: gemini-task@local-mac
updated_at: "2026-11-25T18:58:00-08:00"
confirmed_by: user@web
confirmed_at: 2026-11-25T21:27:58+08:00
---

## 阶段目标

落地云端唯一大脑、全渠道跨天记忆与边缘触手架构

## 最近完成

- **云端唯一大脑与多节点边缘触手闭环（第 27 节门禁通过）**：
  - 原生边缘触手中枢（`src/sugent/edge-tentacle-hub.ts` + `/amb/api/steward/edge/*`）：支持本机 `local-mac` 与云端 `gce-remote` 轻量触手扫描 `STATUS.md` 五节状态卡与 `docs/ROADMAP.md` 进度（Tier `0/1/2` 隐私裁剪与本地路径脱敏），时序安全令牌鉴权、多节点脉冲合并、120s 租约指令拉取及幂等微信完工回执。
  - 全渠道跨天对话记忆召回（`src/sugent/chat-transcript-recall.ts`）：打通 SQLite 历史消息与 Web 幕僚轮次（`steward-web-turns.jsonl`），支持容器重启后自动回填最近私聊上下文，并为 `StewardLlmAgent` 挂载 `recall_chat_history` 与 `dispatch_edge_antigravity` 工具，根治“昨天聊了什么”跨天失忆与跨机项目盲区。
  - 独立触手 CLI 与守护套件（`src/cli/edge-tentacle.ts`、`deploy/edge-tentacle/`）及 HTTPS 反代 `Secure` Cookie 加固。
- **Roadmap v2.0 Wave P0 / P1 / P2 全量收官（第 1–26 节门禁全绿）**。

## 在途

- 待主人执行 `git commit && git push origin main`，在云端中枢更新镜像、开启 HTTPS 域名反代并挂载本机/云端轻量触手守护。

## 下一步

1. 推送 `main` 分支触发 GHCR 构建新版镜像，在云端中枢拉取重启并配置 `SUGENT_EDGE_TOKEN`。
2. 在 Mac 本机与云端开发机启动 `edge:tentacle` 守护，通过微信与 HTTPS Web 工作台零折损共享同一颗顶层管家大脑。

## 卡点

- 暂无阻塞卡点；第 1–27 节核心契约门禁与新增单测全部通过。
