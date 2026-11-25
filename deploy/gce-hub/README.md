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
