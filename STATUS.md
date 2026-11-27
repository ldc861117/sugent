---
status_version: 1
project: sugent
review_state: pending_review
updated_by: agent@local-mac
updated_at: "2026-11-27T18:00:00+08:00"
confirmed_by: ""
confirmed_at: ""
---

## 阶段目标

完成边车 v1 契约与自动升级，静待助理微信养号期满扫码

## 最近完成

- 修复 `AirTokenOpsBridgeClient` 在 GCE 容器内的公网回环 NAT 丢包问题（`deploy/gce-hub/compose.yml` 补充 `host-gateway` 映射与 `stop_grace_period: 15s`，并将默认超时放宽至 20s）。
- 对齐 `WeChatEnvoySidecarClient` 至 `agent-wechat-native` `/v1` 真实接口（`serverId` 重建保护、SSE 游标与 `live` 6 分钟防刷屏过滤、`Idempotency-Key` 幂等外发回执恢复）及共享容器环回网络。
- 在 `deploy/gce-hub/compose.yml` 新增标签限定的 `sugent-updater` 自动滚动升级守护（物理隔离同机 `airtoken`），并将 `App.pushToOwner` 接入 `WeixinAdaptiveQuotaGuard` 低配额合卡与飞书降级；归档 `P3.5` 备用机新号注册。

## 在途

- [观察窗·2026-12-02] 备用机助理微信号 5–7 天移动流量日常养号静默期（关联 P3.6）

## 下一步

1. [我·2026-12-02] 养号满期当天拿备用手机扫一次二维码确认登录助理微信号（关联 P3.7）
2. [AI] 助理号扫码合龙后在内部测试群验证非 `@` 静默纪要与耳麦代回闭环

## 卡点

- 无
