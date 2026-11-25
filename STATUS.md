---
status_version: 1
project: sugent
review_state: pending_review
updated_by: gemini-task@local-mac
updated_at: "2026-11-25T04:55:00-08:00"
confirmed_by: ""
confirmed_at: ""
---

## 阶段目标

完成 GCE 微信上线收尾与 Wave P1 + UI/网关修复合入

## 最近完成

- **路线一（GCE 常驻微信中枢已上线连通）**：`airtoken-micro` 上的 `sugent-gce-hub` 容器已健康运行（`Up (healthy)`，仅绑定 `127.0.0.1:3600`），已接入同机 `CLIProxyAPI` 统一网关并完成主人微信扫码绑定（`Confirmed · 微信已连接`），本机 `local-mac` 单持有者防抢锁环境变量已生效。
- **路线二（Wave P1 全量实现 + 两项线上体验缺陷修复）**：
  - Wave P1（`P1.1–P1.4`）四模块及第 25 节门禁全绿。
  - 修复第三方 OpenAI 兼容网关（如 `CLIProxyAPI`）保存后误报「保存后校验失败」（`src/magpie/supervisor.ts` 回读兼容 Go `omitempty` 空字符串与 `byok-diagnostics.ts` 探测路径适配）。
  - 修复模态对话框（`Sheet` 含 `backdrop-filter`）内 `MenuButton` / `Popover` 下拉菜单向右下漂移与被右侧裁剪的问题（挂载至 `document.body` 并提升层级至 `calc(var(--z-modal) + 4)`）。

## 在途

- 待本机提交并推送代码以触发 GHCR 构建新版镜像，在 GCE 执行 `docker compose pull && docker compose up -d` 热更修复。

## 下一步

1. 提交本轮 Wave P1 与网关/下拉框修复并推送 `origin/main`，更新 GCE `sugent-gce-hub` 容器镜像。
2. 如需开启跨节点 `/ops` 派单协同，在 GCE `~/sugent-hub/.env` 填入 `OPS_BASE_URL` 与 `OPS_NODE_TOKEN`；随后进入 Wave P2。

## 卡点

- 暂无阻塞卡点；待主人确认后提交并推送镜像即可同步至云端容器。
