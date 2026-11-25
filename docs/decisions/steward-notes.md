# Sugent 架构取舍与避坑备忘 (`steward-notes.md`)

## 2026-11-24 · GCE 常驻中枢、微信单持有者守卫与 `/ops` 舰队桥接

1. **微信 iLink 单持有者铁律（防双节点抢消费丢消息）**：
   - 腾讯开源 iLink 协议 `ilink/bot/getupdates` 长轮询在两个进程同时消费同一 `botToken` 时会发生消息争抢丢失。
   - 取舍：不侵入 `src/channels/weixin/` 底层实现，在 `src/sugent/ops-bridge-client.ts` 提供 `evaluateWeixinSingleHolderGuard(env)` 并在 `src/app.ts` 的 `startBot`、`startWeixinLogin`、`channelStatus` 薄层挂载。单机离线模式（未设 `OPS_BASE_URL` 且未设 `SUGENT_WEIXIN_OWNER_NODE`）100% 放行；一旦进入多节点舰队模式，默认仅允许 `gce-hub` 持有微信长轮询与扫码，`local-mac` 自动置为只读提示。
2. **Docker 桥接网络与宿主机环回端口绑定避坑**：
   - 在 `deploy/gce-hub/compose.yml` 中，若将容器内 `AMB_UI_HOST` 设为 `127.0.0.1`，Docker 默认 bridge 网络无法把宿主机 `127.0.0.1:3600:3600` 流量转发进容器内部环回口。
   - 正确做法：宿主机端口映射严格锁定 `"127.0.0.1:3600:3600"`（公网网卡零监听，仅允许 `ssh -L 3600:127.0.0.1:3600` 访问），容器内部保持 `AMB_UI_HOST=0.0.0.0`，同时兼顾零公网暴露与开箱即用转发；容器内存硬限设为 `1536m` 以保障同机 `airtoken-micro` (`e2-medium` 4 GB) 上的远程开发余量。
3. **`mode: "none"` 离线主权与高风险二次确认门禁**：
   - 未配置 `OPS_BASE_URL` 或 `OPS_NODE_TOKEN` 时，`OpsBridgeClient` 保持零网络请求静默退出，单机 BYOK 闭环不受任何云端状态影响。
   - 微信私聊支持 `/ok <id>` 与 `同意` 快速放行一般排期派单，但凡标题或摘要命中资金、合同、对外发言等高风险关键词，强制置 `requiresDashboardConfirm: true` 并拦截微信直接放行，要求前往 `/ops` Web 看板二次确认。
