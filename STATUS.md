---
status_version: 1
project: sugent
review_state: pending_review
updated_by: agent@gce-devbox
updated_at: "2026-11-27T23:50:00+08:00"
confirmed_by: ""
confirmed_at: ""
---

## 阶段目标

落地双人关系星晶引擎试点，静待助理微信养号期满扫码

## 最近完成

- 新增物理隔离的 `DuoStewardCrystallizer`（`src/sugent/duo-steward-crystallizer.ts`）与 `/amb/api/steward/duo/*` 最小权限联邦接口（`SUGENT_DUO_BRIDGE_TOKEN` 零 `owner_private` 泄露），并在 `bigfive-duo-site` 全链路以「Sugent · 星轨幕僚」替换观星仙人，落地关系星晶共阅、时效更替（不翻旧账）、跨源深度复盘与双人微约定回响。
- 修复 `AirTokenOpsBridgeClient` 在 GCE 容器内的公网回环 NAT 丢包问题（`deploy/gce-hub/compose.yml` 补充 `host-gateway` 映射与 `stop_grace_period: 15s`，并将默认超时放宽至 20s）。
- 对齐 `WeChatEnvoySidecarClient` 至 `agent-wechat-native` `/v1` 真实接口（`serverId` 重建保护、SSE 游标与 `live` 6 分钟防刷屏过滤、`Idempotency-Key` 幂等外发回执恢复）及标签限定 `sugent-updater` 自动滚动升级。

## 在途

- [观察窗·2026-12-02] 备用机助理微信号 5–7 天移动流量日常养号静默期（关联 P3.6）

## 下一步

1. [我·2026-12-02] 养号满期当天拿备用手机扫一次二维码确认登录助理微信号（关联 P3.7）
2. [AI] 助理号扫码合龙后在内部测试群与双人白名单群验证静默纪要、耳麦代回及星晶联动闭环

## 卡点

- 无
