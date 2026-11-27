# Sugent GCE 常驻中枢部署指南 (`gce-hub`)

本目录用于在 GCE 虚拟机（如 `airtoken-micro`，`us-central1-a`，`e2-medium` 2 vCPU / 4 GB）上以无界面容器方式常驻运行 Sugent 中枢节点（`gce-hub`），承担以下三项核心职责：

1. **唯一微信机器人持有者**：独占消费腾讯官方 iLink `getupdates` 长轮询，Mac 合盖休眠期间手机微信仍可秒级互动。
2. **跨节点幕僚大脑**：通过 `/api/ops/bridge/steward-pending` 汇总各节点项目脉冲，回答跨端进度查询，并将排期草案写入 `ops_inbox`、签批指令下发至 `ops_commands`。
3. **低运维与零公网暴露**：内存上限设定为 `1536m`（与同机远程开发稳定共存），宿主机仅绑定环回口 `127.0.0.1:3600`，所有 UI 管理与扫码均经 SSH 隧道完成。

## 1. 部署前体检（阶段 B.1）

在目标 GCE 机器上确认内存余量及到微信 iLink 网关（`ilinkai.weixin.qq.com`）与各 BYOK 模型端点的连通性：

```bash
free -m && df -h
```

## 2. 启动常驻容器（阶段 B.3）

1. 在 GCE 机器新建工作目录（如 `~/sugent-hub`），放入本目录下的 `compose.yml` 与 `.env.example`。
2. 基于 `.env.example` 生成 `.env`，将其文件权限设为仅当前用户可读写（`600`），并填入 `OPS_BASE_URL` 与 `OPS_NODE_TOKEN`。
3. 使用 Docker Compose 拉起后台容器：

```bash
docker compose up -d
docker compose ps
```

首次启动若未预设 `AMB_UI_TOKEN`，可在容器内查看 `/data/ui-token` 获取管理令牌。

## 3. SSH 隧道访问 UI 与微信迁移（阶段 C）

1. **先停本机微信通道**：在本机 Sugent 桌面版设置中停用或退出微信通道，并在本机配置 `SUGENT_NODE_ID=local-mac`、`SUGENT_WEIXIN_OWNER_NODE=gce-hub`（单持有者守卫会自动阻止本机误启微信轮询）。
2. **建立本地 SSH 隧道**：
   ```bash
   gcloud compute ssh airtoken-micro --zone=us-central1-a -- -L 3600:127.0.0.1:3600
   ```
3. **扫码绑定**：在本机浏览器访问本地 `127.0.0.1:3600`（附带 `?token=<ui-token>` 参数），在通道设置页扫码绑定微信并配置 BYOK 模型。

## 4. 数据备份与滚动升级（阶段 B.4）

- `/data` 持久化于命名卷 `sugent-data`，建议在 GCE 控制台为宿主机磁盘绑定每日自动快照策略（保留 7 天）。
- 版本升级只需调整 `.env` 中的 `SUGENT_IMAGE` 标签（如切换至指定 `sha-<commit>` 标签）并重新执行 `docker compose up -d`。

## 5. 双微信号「前店后厂」边车部署与防风控运维规范（Wave P3.3 可选扩展）

默认 `compose.yml` 仅运行单容器 `sugent-gce-hub`，保持核心发行版零灰盒依赖。若需挂载独立手机号注册的「助理微信号」承接外部好友私聊与白名单项目群协同，可通过叠加 `compose.wechat-envoy.yml` 启动原生 Rust 无头 `agent-wechat`（`wx serve`）边车。

### 5.1 双微信号角色与权限物理隔离

| 维度 | 主理人个人微信号（后厂指挥室） | 独立手机号助理微信号（前店接待台） |
| :--- | :--- | :--- |
| **接入协议** | 腾讯官方 `openclaw-weixin`（`iLink` 合规通道） | 外置边车 `thisnick/agent-wechat` 原生无头 `wx serve`（`127.0.0.1:6174` / `http://agent-wechat:6174`） |
| **交互对象** | 仅主理人本人私聊（零封号风险） | 外部客户/合作伙伴私聊、白名单项目微信群（`xxx@chatroom`） |
| **安全与记忆域** | `owner_private`（可读写五维私密账本、底价红线、审批拍板与 `/undo` 撤回） | `external_peer`：所有入站消息强制经 `sealExternalEvent` 剥离特权字段并落盘 `0o400` 只读 `.context/` 安全信封，零权限访问主理人私密底价 |
| **群聊纪律** | 接收群纪要日终确认卡与「耳麦请示卡 + A/B 拟稿」 | 白名单群内未 `@提及` 时静默记台账（不插嘴）；仅被明确 `@提及` 时触发耳麦协同代回 |

### 5.2 新助理微信号 5–7 天养号与防风控硬性要求

1. **真实手机号实名与 5–7 天日常养号**：新注册或新换绑的助理微信号切忌首日直接扫云端机房二维码。务必先在备用手机（或安卓应用分身）完成实名认证，与主理人主号及 2–3 位熟人正常互发文字/图片、浏览朋友圈满 **5–7 天**，建立稳定设备信任度后再挂载 `wx serve`。
2. **备用手机常驻在线**：`agent-wechat` 桌面会话要求手机端微信始终保持登录状态（手机端切号退出会导致边车会话掉线），建议使用一台闲置旧手机或安卓独立工作空间常年挂机。
3. **云机房 IP 与登录挑战规避**：GCE（`us-central1-a`）属于数据中心网段，若首次扫码遇到异地网络环境校验，可通过环境变量 `AGENT_WECHAT_PROXY` 为边车配置固定住宅出口代理，或先在受信 Linux 环境完成官方 Profile 初始化后再迁入 `/var/lib/agent-wechat` 数据卷。
4. **严格门控与限频护栏**：保持 `SUGENT_WECHAT_ENVOY_GROUP_POLICY=allowlist`（严禁全群敞开回复），客户端内置每会话每分钟最多 6 条滑动窗口限频，防止异常循环触发微信频控。

### 5.3 组合启动与环境变量配置

在 GCE 宿主机生成高强度边车 Bearer Token（严禁将 `6174` 端口暴露至公网，仅限 `127.0.0.1:6174` 或 Docker 内网 `http://agent-wechat:6174` 通信），并在 `.env` 中配置 `SUGENT_WECHAT_ENVOY_*` 变量后叠加启动：

```bash
docker compose -f compose.yml -f compose.wechat-envoy.yml up -d
docker compose -f compose.yml -f compose.wechat-envoy.yml ps
```

### 5.4 快照缓存定期清理（`/var/cache/agent-wechat`）

`agent-wechat` 运行只读快照与媒体解码缓冲写入 `/var/cache/agent-wechat`（独立挂载于 `agent-wechat-cache` 卷，与存放登录态密钥的 `/var/lib/agent-wechat` 严格分离）。为保障 GCE `29G` 根分区余量，建议每周清理超过 3 天的临时缓存：

```bash
docker exec agent-wechat-native sh -ceu 'find /var/cache/agent-wechat -mindepth 1 -mtime +3 -exec rm -rf {} +'
```
