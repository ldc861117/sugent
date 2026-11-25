---
status_version: 1
project: sugent
review_state: pending_review
updated_by: gemini-task@local-mac
updated_at: "2026-11-24T19:32:00-08:00"
confirmed_by: ""
confirmed_at: ""
---

## 阶段目标

打通 GCE 常驻中枢、微信单持有者与 `/ops` 舰队闭环

## 最近完成

- 完成 `src/sugent/ops-bridge-client.ts`：实现 1h JWT 缓存与提前 5 分钟续期、`401` 自动重签、Tier `0/1/2` 脉冲裁剪、仅 Tier `2` 文档同步、按状态幂等指令回执、`gce-hub` 专属快照同步及 `mode: "none"` 零请求静默。
- 完成管家双模与微信审批闭环：在 `SugentStewardHostService`、`StewardLlmAgent`、`OwnerChannelStewardRouter` 与 `App` 接入远端 `/ops` 快照、`manage_ops_fleet` 草案提报（含资金/合同/对外发言高风险看板二次确认拦截）、`/ok <id>` 放行下发 `ops_commands`、1 分钟去重推送及微信单持有者守卫。
- 完成无界面部署与门禁：新增 `deploy/gce-hub/{compose.yml,.env.example,README.md}`（`1536m` 内存上限、`127.0.0.1:3600` 环回绑定）、独立 `.github/workflows/sugent-image.yml`，并在 `package.json` 与 `scripts/verify-sugent.mjs` 第 24 节注册全套单测与契约自检。

## 在途

- 对齐并收口 `Andy-web` 仓库未提交的 `/ops` 服务端改动与 Cloud Run Firestore 环境变量（阶段 A）。

## 下一步

1. 在 `Andy-web` 仓库收口 `/ops` 改动，开启 Cloud Run `OPS_STORAGE_MODE=firestore` 并配置 `OPS_NODE_TOKEN_LOCAL_MAC` 与 `OPS_NODE_TOKEN_GCE_HUB`。
2. 在 GCE `airtoken-micro` 实例按 `deploy/gce-hub/README.md` 启动 `sugent-gce-hub` 容器，经 SSH 隧道完成微信迁移扫码与端到端联调。

## 卡点

- 阶段 A（Cloud Run 密钥与 `firestore.rules` 发布）及阶段 B/C（GCE 线上拉起与手机微信本人扫码）需主人授权与实机扫码配合。
