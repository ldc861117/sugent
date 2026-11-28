# 2026-11-28 · 云端 Sugent 零盲区全量项目视野与 DSH 双向工具桥接方案

> **商业策略自省四问门禁（Pre-Plan Commercial Reflection Gate）**：
> 1. **付费锚点（Why Pay & Moat）**：属于商业版「全天候常驻碳硅幕僚总控」核心壁垒。相比通用大模型/大厂办公套件（仅见单窗静态上传），Sugent 实现「云端常驻大脑 + 本机只读触手 + `/ops` 治理真值」跨端无感同频，主理人在任何设备零拷贝直问全域进度与明细。
> 2. **合规与分发（Distribution & ToS Risk）**：零非官方协议、零客户端硬编码密钥；所有跨节点读取受 `ProjectPrivacyRegistry` Tier 0/1/2、路径脱敏、白名单文档目录与主理人私域门禁约束，`.env` / `08_career/` / `../` 等绝对阻断，100% 通过桌面签名与企业安全审计。
> 3. **离线退路（Sovereignty Fallback）**：无云端 `/ops` 时，本地 BYOK 对话与 `local_disk` 只读治理文档检索完全独立可用；当 Mac 休眠离线时，GCE 容器可依托双源持久化快照与合成视图保持完整路线图阶段明细不断档。
> 4. **一人公司运维杠杆（OPC Ops Leverage）**：沿用既有 `edge-tentacle` HTTP 轮询（仅调优默认周期为 `15s`）+ DSH 回环插件 `amb-steward-fleet.mjs`，不新增端口、容器或运维组件。

---

## 一、核心病灶回溯

1. **路线图脱水丢明细**：`edge-tentacle-hub.ts` 原只上报 `activeNode + totals`（`9/15` 等汇总数字），未把已同步的 `nodes[].items[]`（阶段清单与 `P1.1..P4.3` 条目）与 `docs/plans/` 计划列表传回云端。
2. **离线脉搏冻结与持久化缺失**：`steward-host-service.ts` 未落盘持久化 `remoteOpsSnapshot`，且合并时无条件 `ep.statusCard ?? prev.statusCard` 导致旧离线快照覆盖 `/ops` 较新状态、离线节点 `"running"` 僵死。
3. **DSH 主对话与管家工具割裂**：Web 主对话跑 DSH 运行时，未挂载 `StewardLlmAgent` 的 `manage_ops_fleet` / `read_repo_doc` 能力，导致模型只能用 `bash` 翻容器 JSON。

## 二、三层实施清单

1. **全量路线图树与计划列表同步（`ops-bridge-client.ts`, `edge-tentacle-hub.ts`, `edge-tentacle.ts`, `web/server.ts`）**
   - `parseRepoRoadmapMarkdown` 保留全量 `nodes[].items[]`（编号/标题/状态/`actor`）与 `gates`、`overallProgress`；
   - 新增 `scanRecentRepoPlans` 扫描最新 8 篇 `docs/plans/*.md`；
   - 新增 `"read_repo_doc"` 只读动作（严守白名单目录、路径脱敏与防外泄零微信通知）。
2. **时间戳感知双源合并与跨端读档（`steward-host-service.ts`, `steward-llm-agent.ts`）**
   - 持久化 `ops-remote-snapshot.json`；按状态卡/活动时间比较新旧，离线节点不再保留僵死 `running`，且始终保留 `roadmapSummary.nodes`；
   - 新增 `readProjectGovernanceDoc`（本地优先 → 在线边缘实时拉取 → 离线结构化快照合成兜底）；
   - 为 `manage_ops_fleet` 与 `buildOwnerAgentBrief()` 注入全量阶段感知与免盲翻指引。
3. **DSH 原生回环工具 `steward_fleet`（`dsh-runtime/plugins/amb-steward-fleet.mjs`, `agent/bridge.ts`, `agent/manager.ts`, `agent/host.ts`, `app.ts`）**
   - 通过 `/dsh/steward-fleet` 暴露 `overview`、`read_doc`、`dispatch_coding`、`complete_todo`，在私聊场景直连 `StewardHostService`，群聊与只读观察规则强制拦截。
4. **Git 同步防漏脉冲与 `TASKS.md` 工单池零延迟直出（阶段增补）**
   - `edge-tentacle-hub.ts` 新增 `inspectRepoGitSyncForEdge`（单次 `git status --porcelain=v2 --branch` + `for-each-ref --no-merged=HEAD` 采集未提交、未 push、落后远端与近 14 天未合入 PR 分支）及 `parseRepoTasksMarkdown`（提取 `[PN.M]`、`#slug`、黑盒 `AC:` 与 `>150` 行归档信号，统一忽略 `[-]` Backlog 并兼容 `窗口 N` 标题）；
   - `steward-host-service.ts`、`steward-llm-agent.ts` 与 `amb-steward-fleet.mjs` 同步透传 `gitSyncAlerts`、`tasksSummary` 与离线 `TASKS.md` 快照合成，使 Sugent 零轮询秒报“未合代码/未推仓库”并按 `#slug + AC` 精准派单。
