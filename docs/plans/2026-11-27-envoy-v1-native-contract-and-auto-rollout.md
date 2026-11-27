# Wave P3 加固：`agent-wechat-native` `/v1` 真实契约对齐、GCE 自动滚动升级与主动配额守卫接线

> 关联主干：`docs/ROADMAP.md` Wave P3 · `AGENTS.md` §3.3 & §5 · `src/sugent/wechat-envoy-sidecar.ts` · `deploy/gce-hub/`

## 0. 商业策略自省四问（AGENTS.md §3.3 强制门禁）

| 自省维度 | 核心拷问 | 本方案的守线决策 |
| :--- | :--- | :--- |
| **1. 付费锚点（Why Pay & Moat）** | 属于开源引流基座还是商业付费增值？相比竞品优势在哪？ | **开源基座**：主动推送配额保护（`WeixinAdaptiveQuotaGuard`）与无侵入边车 HTTP 协议契约完全透明。**商业增值**：云端常驻唯一主脑的零停机自动滚动升级与双微信号防重发、防历史刷屏确定性协同，彻底免除一人公司主理人的手工 SSH 运维看护税。 |
| **2. 合规与分发（Distribution & ToS Risk）** | 能否顺利通过 macOS 公证、Windows 签名与企业审计？有无封号风险？ | Sugent 核心仓与商业安装包保持零非官方协议二进制（`SUGENT_WECHAT_ENVOY_ENABLED=false` 默认关闭）；边车通过共享容器环回命名空间（`127.0.0.1:6174`）隔离通信，且增加 `origin == "live"` 5 分钟实时窗过滤与 `Idempotency-Key` 单次幂等外发，消除历史同步刷屏与超时重复发送引发的频控风险。 |
| **3. 离线退路（Sovereignty Fallback）** | 剥离云端账号进入 `mode: "none"` 后，核心闭环是否依然完整自洽？ | 单机 `mode: "none"` 离线模式下，边车轮询器与云端镜像更新守护均不介入，本地 BYOK 对话、五维账本与安全信封 100% 独立自洽。 |
| **4. 一人公司运维杠杆（OPC Ops Leverage）** | 是否符合“无状态边缘服务 + 端侧重逻辑”，确保日常运维趋近于零？ | 通过 `WATCHTOWER_LABEL_ENABLE=true` 仅针对 `sugent-gce-hub` 标签容器执行自动拉新重启与旧镜像清理，推 `main` 后 5 分钟内云端自动换新，且物理隔离同机 `airtoken` 实盘容器；彻底消灭人工敲 `docker compose pull` 的伪待办。 |

---

## 一、核心工程改动

1. **`WeChatEnvoySidecarClient` 原生对齐 `agent-wechat-native` `/v1` API（`src/sugent/wechat-envoy-sidecar.ts`）**：
   - **状态与服务端重建识别**：优先探测 `GET /v1/status` 与 `GET /v1/accounts`，提取 `serverId` 与默认 `accountId`；`WeChatEnvoyPoller` 持久化 `serverId`，当边车重建导致 `serverId` 变化时自动安全重置旧游标，避免卡死在过期游标（HTTP 410）。
   - **SSE 事件流增量拉取与实时过滤**：支持 `GET /v1/events/stream?after=<cursor>`（带 `Last-Event-ID` 与有界流读取窗口），解析 `message.committed` 事件并按需调用 `GET /v1/messages/{messageId}` 补全正文；对带 `origin` 标记的事件仅放行 `origin === "live"` 且在最近 6 分钟内的实时消息（历史同步与撤回事件仅推进游标不触发回复），同时保留 `/api/events` 与 `/api/chats` 兼容回退。
   - **出站 `Idempotency-Key` 幂等发送与超时核查**：优先调用 `POST /v1/accounts/{accountId}/sends` 并附带唯一 `Idempotency-Key`；若遇超时/408/429/5xx 绝不盲目重发，而是查询 `GET /v1/accounts/{accountId}/sends/by-idempotency-key/{key}` 核实回执状态，遇 `partial`/`needs_review` 立即熔断报错供人工核查。
2. **容器共享环回网络与标签限定自动升级（`deploy/gce-hub/`）**：
   - `compose.wechat-envoy.yml`：将 `agent-wechat` 设为 `network_mode: "service:sugent-hub"`，使 `wx serve` 严守 `127.0.0.1:6174` 环回监听的同时，`sugent-gce-hub` 可直接经 `http://127.0.0.1:6174` 零桥接损耗访问。
   - `compose.yml`：为 `sugent-hub` 添加 `com.centurylinklabs.watchtower.enable=true` 标签，并新增 `64m` 内存上限的 `sugent-updater`（开启 `WATCHTOWER_LABEL_ENABLE=true` 与 `WATCHTOWER_CLEANUP=true`），确保仅自动升级 `sugent-gce-hub` 而不触碰同机其他容器。
3. **宿主主动推送接入 `WeixinAdaptiveQuotaGuard`（`src/channels/weixin/channel.ts` + `src/app.ts`）**：
   - `WeixinChannel` 暴露只读 `ownerQuotaSnapshot()`；`App.pushToOwner(text, opts)` 经 `weixinQuotaGuard.routeProactivePush` 路由：低配额（`<= 3`）时自动缓冲合并非紧急通知，配额耗尽或过期时平滑回退飞书备用通道，水位恢复后优先冲刷缓冲摘要。
4. **人机职责边界纠偏与路线图拆解（`docs/ROADMAP.md` + `STATUS.md`）**：
   - 将主理人已完成的物理动作 `P3.5`（备用机新卡注册助理微信号）正式记为 `[x]`；将养号静默期拆为 `P3.6 [观察窗·2026-12-02]`，将期满真机扫码拆为唯一物理动作 `P3.7 [我·2026-12-02]`，所有容器升级与配置工作 100% 归入 `[AI]` 与自动守护。
