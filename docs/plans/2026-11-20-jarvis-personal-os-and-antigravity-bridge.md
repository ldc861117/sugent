# Sugent 个人生命幕僚 OS 与 Antigravity 双向桥接实施计划

**Goal:** 把 Sugent 从“后台任务与规则面板”改造成围绕具体用户生长的个人生命幕僚，在 [`src/sugent/`](../../src/sugent/) 零侵入落地五维生命账本、随手暂存第一入口与有分寸主动伴行引擎，并打通本机 Antigravity App 的双向统帅桥接。

**Architecture:** 新增领域模块全部落入 [`src/sugent/`](../../src/sugent/)，复用既有的 [`knowledge-graph.ts`](../../src/sugent/knowledge-graph.ts)、[`kernel.ts`](../../src/sugent/kernel.ts)、[`sources.ts`](../../src/sugent/sources.ts)、[`security-envelope.ts`](../../src/sugent/security-envelope.ts)、[`receipt-protocol.ts`](../../src/sugent/receipt-protocol.ts)、[`gateway.ts`](../../src/sugent/gateway.ts) 与 [`causal-ledger.ts`](../../src/sugent/causal-ledger.ts)。桌面端仅在 [`electron/main.ts`](../../electron/main.ts) 挂接全局热键与托盘拖拽薄转发，外出触达复用 [`src/core/outbox.ts`](../../src/core/outbox.ts) 与 [`WeixinChannel`](../../src/channels/weixin/channel.ts) / 飞书卡片，不改上游主干逻辑。

**Tech Stack:** TypeScript 5.x (ESM, `NodeNext`), Node.js >= 22.13 (`node:sqlite` `DatabaseSync`, `node:child_process` `execFile`, `node:crypto`, `node:fs`), Electron 44 (`globalShortcut`, `Tray`), Vitest。

## 0. 商业策略自省四问（AGENTS.md 强制门禁）

动手写代码前，先对照 [`AGENTS.md`](../../AGENTS.md) 第 3 节完成四项门禁审查：

| 自省维度 | 核心拷问 | 本规划的架构落位与守线做法 |
| :--- | :--- | :--- |
| 1. 付费锚点 | 哪些属开源引流基座，哪些属商业增值？对比 WorkBuddy 与千问办公优势在哪？ | 单机五维账本、Universal Dropzone 暂存与 80% 准备兜底、BYOK 四角色路由、Antigravity 只读状态聚合全量开源引流。Pro/Team 订阅承接跨设备 E2EE 记忆漫游（衔接 [`P2 同步方案`](./2026-11-12-p2-byok-diagnostics-and-e2ee-sync.md)）、外出微信/飞书实时加密审批中继（衔接 [`P0 Auth Broker`](./2026-11-12-p0-sugent-auth-broker.md)）与团队规则包。大厂办公套件锁在企微或钉钉组织云空间内，碰不到用户的私人档案、本地代码仓与异构智能体。Sugent 守住跨生态中立、本机隐私隔离与防社死拍板确定性。 |
| 2. 合规与分发 | 能否通过 macOS 公证、Windows 签名与平台风控审查？ | 按三表面只读打开本机 `~/.gemini/antigravity{,-cli,-ide}/conversation_summaries.db?mode=ro`，钩子与 MCP 收口进独立插件目录 `plugins/sugent-steward/`（绝不覆盖用户全局配置）。派活只调官方 CLI `~/.gemini/antigravity/bin/agentapi` 的 `execFile` 参数数组，不探测未文档化端口。桌面安装包只放公开 `clientId`，零第三方硬编码密钥。外部投影须过动态三级隐私门禁与本机 Diff 确认。 |
| 3. 离线退路 | 剥离云端账号进入 `mode: "none"` 后，核心能力是否独立可用？ | 断网或配置 `mode: "none"` 时，五维账本、Dropzone 四档分流、`HumanPrepBundle` 准备卡、本地 BYOK/Ollama 推理、Antigravity 本地状态读取与规则巡检全部本机独立运行。可选外部展示端断开后，本地工作流零阻塞。 |
| 4. 一人公司运维杠杆 | 能否做到零云端重状态服务器与低日常维护成本？ | 失衡扫描与注意力配额 Gate 均为纯函数或本地小文件。数据无增量时由 `ZeroTokenProbeTracker` 直接 0 Token 退出。等待主人拍板期间写入 `SuspendedRoundStore` 释放进程，挂起期零驻留轮询，不新增任何云端数据库。 |

## 1. 三体协同边界与 `/ops` 互补分工

既有的外部看板策划（以公网站点结合多端调度为例）把对外展示的个人站同时当成私密总控面板，实际运行暴露出三处结构矛盾。第一，个人站容器配置 `min-instances=0`，叠加本机休眠与另起同步进程后，会出现 15 分钟级别的状态唤醒盲区。第二，把私密客户档案、资金账本或未脱敏 HTML 原型推上公网容器，会直接放大隐私泄露与 Self-XSS 风险。第三，人在外面用手机打开网页看长看板、点多层按钮，远不如直接在微信或飞书自聊窗口收一张拍板卡顺手。

为了消除职责重叠，系统按**三体分工（The Sovereign Triad）**切分边界，并划清与外部 `/ops` 看板的互补界面（理念依据见 [`PHILOSOPHY.md`](../PHILOSOPHY.md)，演进定位见 [`ROADMAP.md`](../ROADMAP.md)）：

| 成员 | 边界定位 | 持有的数据与职责 | 严禁越界行为 |
| :--- | :--- | :--- | :--- |
| Sugent | 不开网页时的随身幕僚与五维总账 | 持有五维生命账本、私密档案索引、微信/飞书唯一交互人格与审批 Outbox，消费本地跨端脉冲 | 不在 Sugent 内重复搬运 `/ops` 看板页面，不强迫用户建多 Bot，不裸传私密正文 |
| Antigravity App | 重装工程与深度课题特种兵团 | 承担多文件编码、重构、Swarm 并行调研与长周期执行，通过官方 CLI 与插件目录钩子汇报 | 不直接向主人微信刷屏推零碎过程状态，不直接读写 Sugent 私人账本 |
| 外部 `/ops` 看板与公域站 | 浏览器打开时的舰队全景战情视图与公域发布通道 | 展示多节点矩阵与实时运行态，仅接收经动态隐私分级与主人确认后的脱敏计数或公开定稿 | 不替代五维私人总账与手机端即时拍板，不存放未脱敏私人账本与半成品正文 |

**契约隔离硬红线**：上述外部案例仅用于说明问题边界。Sugent 源码（[`src/sugent/`](../../src/sugent/)）、配置文件与测试用例中，严禁硬编码任何特定个人网站名称或私人项目代号。所有向公域站点或外部看板投递的动作，一律走两个可插拔标准接口：

```typescript
export type PrivacySovereigntyTier = "local_only" | "metadata_only" | "summary_allowed";

export interface CanonPublishDraft {
  canonId: string;
  title: string;
  slug: string;
  markdownBody: string;
  privacyTier: Exclude<PrivacySovereigntyTier, "local_only">;
  sourceRefs: string[];
  unifiedDiffPreview: string;
}

export interface PublicCanonPublisher {
  readonly publisherId: string;
  dryRunDiff(draft: CanonPublishDraft): Promise<{ diffText: string; redactionWarnings: string[] }>;
  publishCanon(draft: CanonPublishDraft, ownerConfirmedHash: string): Promise<{ publishedUrl: string; at: string }>;
  revokeCanon(slug: string, ownerConfirmedHash: string): Promise<void>;
}

export interface OpsProjectionSnapshot {
  snapshotId: string;
  generatedAt: string;
  privacyTier: Exclude<PrivacySovereigntyTier, "local_only">;
  projectCounts: { active: number; waitingReview: number; offlineVolumes: number };
  items: Array<{
    projectKey: string;       // 经本机映射的脱敏代号，不含真实私有绝对路径
    status: "idle" | "running" | "waiting_review" | "volume_offline";
    updatedAt: string;
    sanitizedSummary?: string; // 仅 summary_allowed 级别允许填充
  }>;
}

export interface OpsProjectionSink {
  readonly sinkId: string;
  projectSnapshot(snapshot: OpsProjectionSnapshot): Promise<{ accepted: boolean; reason?: string }>;
  healthCheck(): Promise<{ reachable: boolean; coldStartMs?: number }>;
}
```

面向普通用户的交互侧守住**唯一前台人格（One Jarvis）**原则。用户自始至终只和同一个懂前因后果的私人幕僚说话，模型角色路由（`assessor` / `executor` / `computer_use` / `steward`）全部由 [`gateway.ts`](../../src/sugent/gateway.ts) 在后台自动匹配，桌面端、微信端与 Antigravity 特种兵团只作幕后能力供给。普通用户不必手建多个 Bot，不必手动切模型，也不用写 Cron 表达式。

## 2. 五维生命账本与主动伴行引擎设计

### 2.1 五维生命账本（`src/sugent/stewardship-ledger.ts`）

现有 [`knowledge-graph.ts`](../../src/sugent/knowledge-graph.ts) 偏重技术实体与工作流结晶，缺少面向“人”的信任阶梯、承诺因果环与红线约束。`src/sugent/stewardship-ledger.ts` 建立五维生命账本，落盘于 `<dataDir>/sugent-stewardship/ledger.json`（原子写 `0o600`）并同步写入只追加流水 `ledger-journal.jsonl`。

```typescript
export type ContextPartition = "personal_life" | "work_project" | "cowork_shared";

export type TrustTier =
  | "L0_record_only"       // 只记不评：静默收存与检索，不主动建议
  | "L1_whisper_prompt"    // 耳麦提词：仅向主人推送摘要与 A/B 选项
  | "L2_suspend_approval"  // 挂起待批：预备动作并写入 SuspendedRoundStore 等拍板
  | "L3_shadow_autonomous";// 影子转正自治：observe 满 3 次无误并经主人确认后执行

export interface RelationshipProfile {
  id: string;
  partition: ContextPartition;
  subjectType: "owner_trust" | "key_contact";
  name: string;
  roleTag: string;          // 如 "owner" / "client" / "family" / "partner"
  trustTier: TrustTier;
  verifiedObservations: number;
  taboos: string[];         // 雷区与禁忌（如 "不谈降价" / "忌晚9点后打扰"）
  preferences: string[];    // 沟通偏好（如 "先给结论再附数据"）
  openFavors: string[];     // 未结人情或往来备忘
  updatedAt: string;
}

export interface GoalNorthStar {
  id: string;
  partition: ContextPartition;
  title: string;
  northStarCriterion: string; // 硬北极星判据，非口号
  status: "active" | "paused" | "achieved" | "superseded";
  targetDateIso?: string;
  lastProgressAt: string;
  stallThresholdDays: number; // 超过该天数零进展即触发失衡扫描
}

export interface ValueGuardrail {
  id: string;
  partition: ContextPartition;
  kind: "hard_redline" | "tombstone" | "soft_taste";
  statement: string;
  enforcement: "block_and_alert" | "warn_before_send" | "style_hint";
  evidenceSource?: string;  // 若为证伪墓碑，记录来源复盘或 Antigravity 驳回批注
  createdAt: string;
}

export interface CommitmentItem {
  id: string;
  partition: ContextPartition;
  direction: "i_owe" | "waiting_for" | "expiring";
  status: "open" | "snoozed" | "waiting_review" | "closed" | "superseded";
  summary: string;
  counterpartyOrRef: string; // 对方人脉 id、Antigravity conversationId 或证件名
  dueAt?: string;
  remindLeadDays?: number;
  updatedAt: string;
}

export interface ResourceEntry {
  id: string;
  partition: ContextPartition;
  kind: "time_window" | "personal_archive" | "budget_cap" | "specialist_agent";
  title: string;
  localUriOrPath?: string;  // 本地证件/合同/保单索引路径，不出本机
  expiresAt?: string;
  metadata: Record<string, string | number | boolean>;
}
```

账本通过三项硬约束保持清晰可控：

1. 主目标并发上限设为 `MAX_ACTIVE_GOALS = 3`。新增第 4 个 `active` 目标时，必须先归档或暂停旧目标，避免精力摊薄。
2. `TrustTier` 晋升为 `L3_shadow_autonomous` 必须同时满足 `verifiedObservations >= 3`（对齐 [`kernel.ts`](../../src/sugent/kernel.ts) 的 `shouldSuggestRulePromotion`）和主人显式确认；主人随时可用一句口令调用 `downgradeTrustTier()` 秒级降回 `L1` 或 `L0`。
3. 事务检索严格按 `partition` 过滤。只要调用来源属于外部工作或 Cowork 协作域，`personal_life` 分区数据直接物理不可见。

**与 `SugentKnowledgeGraph` 的兼容映射**：每次账本变更后，同步生成 `KGDelta` 写入 [`SugentKnowledgeGraph`](../../src/sugent/knowledge-graph.ts)。其中 `RelationshipProfile` 映射为 `kind: "person"`，信任等级变更写入 `has_trust_tier` 边且标记 `exclusive: true`。`GoalNorthStar` 映射为 `kind: "concept"`（标签 `["ledger:goal"]`），主目标切换写入 `focuses_on` 边且标记 `exclusive: true`，确保旧目标边自动填入 `supersededAt`。`ValueGuardrail` 与 `CommitmentItem` 分别映射为 `preference` 与 `concept` 节点，供 `recallSubgraph()` 做 2 跳上下文召回。

### 2.2 通用第一入口与无工具 80% 准备兜底（`src/sugent/universal-dropzone.ts`）

日常碎片进入 Sugent 时，用户不需要先选“归档 / 搜记忆 / 跑任务”模式。`src/sugent/universal-dropzone.ts` 先对原始输入（例如文字、剪贴板内容，或拖入的文件与微信转发）做轻量分流，把所有输入归为四档之一：

```typescript
export type DropzoneIntentClass = "capture" | "recall" | "advise" | "delegate";

export interface DropzoneInput {
  inputId: string;
  channel: "desktop_hotkey" | "tray_drop" | "weixin" | "feishu" | "web_ui";
  partition?: ContextPartition;
  text: string;
  filePaths?: string[];
  receivedAtIso: string;
}

export interface HumanPrepBundle {
  taskTitle: string;
  missingAutomationReason: string; // 诚实说明哪一段必须人工线下/浏览器本人点确认
  checklist: string[];             // 查清的办理路径、窗口材料清单与避坑顺序
  localMaterials: Array<{ label: string; localPath: string; expiresAt?: string }>;
  readyToCopyDrafts: Array<{ channelHint: string; text: string }>;
  followupCommitment: Omit<CommitmentItem, "id" | "updatedAt">;
}

export type DropzoneOutcome =
  | { intent: "capture"; receiptLine: string; storedLedgerIds: string[] }
  | { intent: "recall"; answer: string; matchedRefs: string[] }
  | { intent: "advise"; tradeOffBrief: string; guardrailWarnings: string[] }
  | { intent: "delegate"; mode: "automated_trigger"; trigger: PersonalTrigger }
  | { intent: "delegate"; mode: "human_prep_bundle"; bundle: HumanPrepBundle };
```

四档分流的执行规则保持明确收敛：

1. `capture`（随手暂存）：优先经本地确定性规则与 `assessor` 小模型抽取类别，直接写入 `StewardshipLedger` 与本地档案目录，返回**单行极短回执**（例如「已存进「车辆年检」档案，到期前 14 天提醒你」），绝不弹表单追问字段。
2. `recall`（秒翻家底）：并行检索五维账本索引、[`SugentKnowledgeGraph.recallSubgraph`](../../src/sugent/knowledge-graph.ts) 与 `ResourceEntry` 本地路径，1 秒级返回结论与原文件位置。
3. `advise`（利害参谋）：拉取 `GoalNorthStar`、`ValueGuardrail`（含墓碑规则）和相关人脉禁忌，只对比代价、底线冲突和建议顺序。
4. `delegate`（交代跑腿）：先查可用执行器与 Antigravity 工具链是否覆盖。能自动跑的生成 `PersonalTrigger` 进 `evaluatePersonalTrigger`；遇到政务、银行、线下沟通或无 API 网页等没有现成工具的琐事，**禁止回复“缺少工具无法处理”**，强制走 `human_prep_bundle` 兜底路径。系统自动查清办理步骤、从 `personal_archive` 翻齐证件与合同路径、写好可直接复制的话术小抄，并在账本里记下一笔跟进提醒，帮主人完成前 80% 准备活。

**[`electron/main.ts`](../../electron/main.ts) 薄适配边界**：在 `boot()` 初始化 `tray` 与窗口后，仅增加约 30 行胶水代码。注册 `globalShortcut.register("CommandOrControl+Shift+Space", ...)` 呼出极简悬浮输入条，并在 `tray.on("drop-files")` / `tray.on("drop-text")` 中直接把拖入文件与文本转交给 `UniversalDropzone.handleDrop()`，收到 `receiptLine` 后用一条原生 `Notification` 回显，不修改渲染进程主路由。

### 2.3 有分寸的主动伴行引擎（`src/sugent/proactive-cadence.ts`）

主动伴行围绕五类时刻工作（**账本失衡、事项临期、任务完工拍板**，以及**周期校准与舰队碰撞告警**），平时无事彻底静默。`src/sugent/proactive-cadence.ts` 拆成纯函数扫描核心与 `createAttentionBudgetGate` 每日配额门控两部分，全模块严格遵守 [`kernel.ts`](../../src/sugent/kernel.ts) 同等纯度门禁（零 `fs`、零网络、零 `Date.now()` / `new Date()`、零随机数、零供应商硬编码），持久化由外部注入可选 `CadenceBudgetStoragePort`（缺省纯内存）：

```typescript
export const DEFAULT_DAILY_NON_URGENT_QUOTA = 2;

export type ProactiveMomentKind =
  | "goal_imbalance"
  | "commitment_expiring"
  | "review_ready"
  | "periodic_calibration"
  | "fleet_collision_or_alert";

export interface CadenceFleetPulseInput {
  id: string;
  dedupeKey: string;
  kind: "red_collision" | "node_or_sidecar_error" | "pending_handoff" | "review_ready";
  projectKey: string;
  nodeId: string;
  summary: string;
  actionHint: string;
  urgency: "normal" | "urgent";
  conversationId?: string;
  superseded?: boolean;
  updatedAtIso: string;
}

export interface ProactiveCandidate {
  candidateId: string;
  dedupeKey: string;
  kind: ProactiveMomentKind;
  urgency: "normal" | "urgent";
  title: string;
  threeLineBody: [string, string, string]; // 强制压缩至三行以内，禁止长篇汇报
  suggestedRoundId?: string;
  targetRefId?: string;
}

export interface CadenceBudgetState {
  dateKey: string;
  nonUrgentSentCount: number;
  dailySoftQuota: number;     // 默认 2
  quietHoursActive: boolean;
  sentDedupeKeys: string[];
  morningDigestQueue: ProactiveCandidate[];
}

export interface CadenceBudgetStoragePort {
  load(): CadenceBudgetState | undefined;
  save(state: CadenceBudgetState): void;
}

export function createDefaultBudgetState(
  dateKey: string,
  dailySoftQuota?: number,
  quietHoursActive?: boolean,
): CadenceBudgetState;

export function scanLedgerImbalances(
  ledger: LedgerSnapshot,
  nowIso: string,
  options?: { calibrationDue?: boolean; fleetPulses?: readonly CadenceFleetPulseInput[] },
): ProactiveCandidate[];

export function gateProactiveCandidates(
  candidates: readonly ProactiveCandidate[],
  budget: CadenceBudgetState,
): { emitNow: ProactiveCandidate[]; foldToMorningDigest: ProactiveCandidate[]; suppressedIds: string[]; nextState: CadenceBudgetState };

export function filterSupersededBeforeSend(
  candidates: readonly ProactiveCandidate[],
  isSuperseded: (candidate: ProactiveCandidate) => boolean,
): { deliverable: ProactiveCandidate[]; supersededIds: string[] };

export function createAttentionBudgetGate(
  storagePort?: CadenceBudgetStoragePort,
  dailySoftQuota?: number,
): {
  getState(dateKey: string): CadenceBudgetState;
  evaluateAndRecord(candidates: readonly ProactiveCandidate[], dateKey: string, quietHoursActive: boolean): { emitNow: ProactiveCandidate[]; foldToMorningDigest: ProactiveCandidate[]; suppressedIds: string[]; state: CadenceBudgetState };
  drainMorningDigest(dateKey: string, isSuperseded: (candidate: ProactiveCandidate) => boolean): { emitNow: ProactiveCandidate[]; supersededIds: string[]; state: CadenceBudgetState };
};
```

`scanLedgerImbalances`、`gateProactiveCandidates` 与 `filterSupersededBeforeSend` 均不触碰文件系统与系统时钟。由外部传入的 `CadenceBudgetStoragePort`（可落盘于 `<dataDir>/sugent-stewardship/cadence-budget.json`）承担读写。门控按四条规则运转：已发送的 `dedupeKey` 直接抑制，`urgent` 级舰队碰撞或节点错误不受软配额与免打扰限制直接放行（仍按 `dedupeKey` 去重），常规候选在免打扰或超过每日上限 `2` 条时折叠进 `morningDigestQueue`，跨日期重置当日计数同时保留待发送的早间摘要队列。

**挂起、投递与发送前二次销账链路**：
1. 当候选属于 `review_ready` 或需要主人取舍时，先通过 [`SuspendedRoundStore`](../../src/sugent/receipt-protocol.ts) 的 `suspend()` 写入 `roundId`、`sessionId` 与未清零的 `hopCount`，随后结束执行轮次（等待期 0 驻留进程、0 轮询 Token）。
2. 免打扰期间折叠进次日早间简报的候选，在次日真实外发前必须走 `drainMorningDigest` 调用 `filterSupersededBeforeSend` 做二次校验。只要本机 IDE 已推进步数或外部已阅，系统自动静默剔除过时候选。
3. 通过核验的候选经宿主 [`Outbox`](../../src/core/outbox.ts) 排队投递至 [`WeixinChannel.notifyOwner`](../../src/channels/weixin/channel.ts) 或飞书卡片（遵循 [`src/app.ts`](../../src/app.ts) 既有的 `pushToOwner` 通道优先级），只发 `threeLineBody` 三行卡片。主人回复编号或短批注后，调用 `SuspendedRoundStore.resume()` 唤醒原会话续接。

## 3. `Sugent ↔ Antigravity App` 双向统帅桥接架构

桥接层落地于 `src/sugent/antigravity-bridge.ts`、`src/sugent/steward-mcp.ts` 与 `src/sugent/memory-gardener.ts`，全部使用本机实测确认的官方接口，不探测任何未文档化私有端口：

```text
[Antigravity App 三表面资产与官方接口]
  ├── antigravity{,-cli,-ide}/conversation_summaries.db (?mode=ro) + .ops_fleet_state.json
  ├── brain/<conv_id>/{implementation_plan,task,walkthrough}.md + *.metadata.json
  ├── plugins/sugent-steward/{plugin.json,hooks.json} (<1ms 子代理短路, 绝不覆写全局 hooks.json)
  └── sidecar_data/<name>/events/
         │
         ▼  [Layer 1 AntigravityStateReader / FleetPulseReader + Layer 2 AntigravityHookSink] (0 Token)
  [src/sugent/security-envelope.ts] (隔离外部正文至只读 .context/event-<id>.md, 0400)
         │
         ▼  [Layer 3 ArtifactComprehensionPipeline] (gateway.ts steward 角色 + 五维目标对齐)
  [微信/飞书三行拍板卡 + SuspendedRoundStore]
         │  (主人微信回复批准 / 驳回 / 批注)
         ▼  [Layer 4 AntigravityDispatcher] (execFile 调用官方 agentapi 3 子命令)
  [agentapi send-message <conv_id> / new-conversation ...]
         ▲  (反向召回红线、挂起越界审批、周度沉淀规则)
  [Layer 5 src/sugent/steward-mcp.ts (收口进 plugins/sugent-steward/) + 周度记忆园丁]
```

### 3.1 Layer 1：`AntigravityStateReader` 与 `FleetPulseReader`（三表面观测、归并与跨端脉冲）

Antigravity 本机同时存在桌面 App、CLI 与 IDE 三类前端，库内近 70% 记录属于 `nesting_depth > 0` 的子代理与 Swarm 会话，同时混有 `project_id` 碎片化与 SSH Host 别名差异。`AntigravityStateReader` 与 `FleetPulseReader` 通过四条规则完成高信噪比聚合：

1. 三表面只读连接与唯一标识：自动扫描 `~/.gemini/antigravity{,-cli,-ide}/conversation_summaries.db?mode=ro`（分别对应 `app | cli | ide`，缺失库静默跳过），通过 `node:sqlite` 的 `DatabaseSync` 配合 `{ readOnly: true }` 打开数据库，以 `(nodeId, surface, conversationId)` 唯一标识，读取 `conversation_id`、`title`、`preview`、`step_count`、`last_modified_time`、`workspace_uris`、`status`、`project_id`、`agent_name`、`parent_conversation_id`、`nesting_depth`、`not_fully_idle`、`killed`、`last_user_input_time` 与 `last_user_input_step_index`。
2. 穿透 SSH 别名的 `canonicalizeProjectKey` 与三类 `sessionRole`：归并时用 `canonicalizeProjectKey` 剥离 SSH Host 别名（如 `git@custom-alias:Owner/Repo.git`）、协议、端口与 `.git` 后缀，统一输出 `repo:<owner>/<repo>` 或 `local:<nodeId>:<slug>`（优先使用工作区 `.ops-project.json` 声明的 `projectKey`）。同时用 `normalizeWorkspaceRoot` 把 `worktrees/<conv_id>/swarm-*` 还原回主仓根，把 `nesting_depth > 0` 子代理折叠到 `parent_conversation_id` 根会话；区分 `interactive`、`readonly-sidecar` 与 `subagent` 三类 `sessionRole`，定时只读巡检正常完工静默不进待审队列，外置卷未挂载时冻结上次快照并标记 `volumeOffline: true`。
3. `48h` 冷启动窗口与跨端脉冲只读消费：冷启动水位截断取 `bootstrappedAt` 与近 `48h` 较近者（`Math.max(bootstrappedAtMs, nowMs - 48h)`），避免首次挂载或久未开机后补发积压旧卡。`FleetPulseReader` 只读解析本地跨端镜像（如 `.ops_fleet_state.json`，缺失或坏 JSON 返回 `[]`）产出 `BridgeFleetCadenceEvent`，直接感知多节点碰撞、节点异常与待领 `Handoff`，不自建云端轮询后台。
4. 状态自动覆盖（`Auto-Supersede`）与 0 Token 退出：结合 `annotations/<conversation_id>.pbtxt` 的 `last_user_view_time`、`last_user_input_step_index`、`step_count`、重回 `RUNNING` 状态及外部已阅水位，只要主人或下游已推进即把旧待批卡标为 `superseded: true`。整份归并快照交由 [`ZeroTokenProbeTracker`](../../src/sugent/sources.ts) 比对 SHA-256，无变化则直接 0 Token 退出。

### 3.2 Layer 2：`AntigravityHookSink` 与独立插件目录隔离

在 [`src/sugent/types.ts`](../../src/sugent/types.ts) 的 `PersonalSourceKindId` 新增 `"antigravity"`，并在 [`src/sugent/sources.ts`](../../src/sugent/sources.ts) 的 `registerBuiltins()` 注册第 4 个内置源适配器（`threadKey` 为 `antigravity:<nodeId>:<surface>:<conversationId>`，入口强制过 `guardPrivilegedEventFields`）。钩子安装器 `stageSugentStewardPluginHooks` 将配置写入独立插件目录 `~/.gemini/config/plugins/sugent-steward/{plugin.json,hooks.json}`（对应 Sprint 3 的 MCP 配置也收口进同一插件目录），若目标指向用户全局 `~/.gemini/config/hooks.json` 软链则直接抛错，严禁覆盖全局配置。

`AntigravityHookSink.handleRawHookStdin` 在首行运行 `isSubagentSession`，识别 `/worktrees/`、`/subagents/` 路径与 `nestingDepth > 0` 后在 `<1ms` 内短路返回（`Stop` 返回 `{"decision":"allow"}`，其他事件返回 `{}`）。根会话钩子脚本剥离 stdio FD（`nohup ... >/dev/null 2>&1 </dev/null &`）做本机旁路异步投递，瞬间向 stdout 输出 `{"decision":"allow"}` 退出，绝不阻塞 Antigravity 停机或关闭会话；入站前把 Antigravity 的 `cwd` 映射为 `workspacePath` 再送入源适配器，避免触发特权字段拦截，同时巡检 `sidecar_data/<name>/events/` 健康回执。

### 3.3 Layer 3：`ArtifactComprehensionPipeline`（物理隔离解读与拍板卡渲染）

当根会话停在 `CASCADE_RUN_STATUS_IDLE` 或 `Stop` 钩子报出 `fullyIdle: true` 时，`ArtifactComprehensionPipeline` 读取 `brain/<conversation_id>/` 中的 `implementation_plan.md`、`task.md`、`walkthrough.md`、筛选 `userFacing: true` 的 `*.metadata.json` 以及 `transcript.jsonl` 尾部摘要。由于这些文件可能间接引用外部 GitHub Issue 或陌生网页正文，进入 Sugent 决策面之前，**必须先经 [`sealExternalEvent`](../../src/sugent/security-envelope.ts) 落盘为 `0o400` 只读文件 `.context/event-<id>.md`**，提示词里只保留校验过的标量引用。

随后流水线通过 [`gateway.ts`](../../src/sugent/gateway.ts) 选取 `steward` 角色模型（遵守供应商中立路由，且 `mode: "none"` 下可直接调用本机 BYOK 或 Ollama），对照 `StewardshipLedger` 的 `GoalNorthStar` 与 `ValueGuardrail`（含墓碑规则），把大篇幅方案压缩为微信/飞书三行拍板卡：

1. 第一行写明推进了哪条主目标与改动边界；
2. 第二行给出风险核查与验证数据（如是否越过 `sidecar.json` 工作区、单测通过几项、是否撞上历史墓碑）；
3. 第三行提供数字回复选项（例如回复 `1` 放行、回复 `2 补充要求` 打回原会话、回复 `3` 暂缓）。

发卡前先写入 `SuspendedRoundStore`，随后释放本地协程，等待期间不消耗任何模型 Token。

### 3.4 Layer 4：`AntigravityDispatcher`（参数数组调度与 8 跳防互叫熔断）

收到主人微信/飞书批复后，`SuspendedRoundStore.resume()` 校验一次幂等性并拼出续接指令，`AntigravityDispatcher` 严禁使用 `exec` 拼接 shell 字符串，统一通过 `node:child_process` 的 `execFile` 传入参数数组调用官方 `~/.gemini/antigravity/bin/agentapi`，且只使用以下三个实测子命令：

```typescript
export interface AgentApiRunner {
  getConversationMetadata(conversationId: string): Promise<AgentApiMetadataResult>;
  sendMessage(params: {
    recipientId: string;
    content: string;
    title?: string;
  }): Promise<{ ok: boolean; exitCode: number }>;
  newConversation(params: {
    prompt: string;
    model?: "flash_lite" | "flash" | "pro" | string;
    title?: string;
    profile?: string;
  }): Promise<{ conversationId?: string; exitCode: number }>;
}
```

调度执行前强制校验三道安全边界。第一，先调 `agentapi get-conversation-metadata <conversation_id>` 确认目标根会话存在且未 `killed`。第二，凡开启 `new-conversation` 或附加工作区读写指令，必须对照 `~/.gemini/config/sidecars/<id>/sidecar.json` 中声明的 `workspace_uris` 与 `access_grants` 白名单，越权目录直接拒派。第三，原会话续跑统一用 `agentapi send-message [--title=<title>] <recipient_id> <content>` 唤醒原 `conversation_id` 继续工作。

整条 `Stop → Sugent 批示 → agentapi send-message` 链路强制复用 [`deriveChildTriggerHop`](../../src/sugent/kernel.ts) 单调递增 `hopCount`。一旦超过 `DEFAULT_MAX_HOPS`（`8` 跳），[`evaluatePersonalTrigger`](../../src/sugent/kernel.ts) 立即触发 `halt_circuit_breaker` 停止自动派活，同时向 [`CausalLedger`](../../src/sugent/causal-ledger.ts) 写入 `circuit_broken` 事实并通知主人手工介入。

### 3.5 Layer 5：`sugent-steward-mcp`、周度记忆园丁与动态隐私分级

反向通信由 `src/sugent/steward-mcp.ts` 实现，将 `sugent-steward-mcp` 服务以 Stdio 或 Streamable HTTP `/mcp` 形态收口注册进独立插件目录 `~/.gemini/config/plugins/sugent-steward/`（与钩子共目录，不修改用户全局 `mcp_config.json`），向 Antigravity 会话提供四个受控工具：

| MCP 工具名 | 核心参数 | 执行行为与硬约束 |
| :--- | :--- | :--- |
| `steward_recall_context` | `workspaceUri`, `query` | 只查询 `work_project` 分区的当前主目标、价值红线与墓碑记录，`personal_life` 分区强制不可见 |
| `steward_request_owner_approval` | `conversationId`, `actionSummary`, `riskLevel` | 写入 `SuspendedRoundStore` 并经 Outbox 向主人微信/飞书推送单点拍板卡，审批前挂起等待 |
| `steward_report_milestone` | `conversationId`, `summary`, `artifactPaths` | 更新账本 `CommitmentItem` 状态，必要时按动态隐私分级向 `OpsProjectionSink` 投递脱敏计数 |
| `steward_propose_canon_diff` | `slug`, `title`, `markdownBody` | 调用 `PublicCanonPublisher.dryRunDiff()` 生成本机 Diff 预览卡，未经主人本机盖印绝不发布 |

**周度记忆园丁（`src/sugent/memory-gardener.ts`）**：本机 `~/.gemini/antigravity/knowledge/<ki>/` 因平时很少手动触发 `/learn` 已停更数月。新设计改为由 Sugent 每周巡检一次（受 `createAttentionBudgetGate` 配额门控），收集本周已验收的 `walkthrough.md`、主人在微信/飞书发回的驳回批注与重复报错，合成**单张周度提案卡**推给主人。主人回复确认后，园丁自动把规范写回目标仓内 `.agents/rules/` 与 `TOMBSTONES.md`，同时写入 [`SugentKnowledgeGraph`](../../src/sugent/knowledge-graph.ts)；同一操作流验证满 3 次即调用 `crystallizeSkillsToDir()` 固化为 `SKILL.md`。

**动态用户主权隐私分级与 `tierEpoch` 防复燃（`ProjectPrivacyRegistry`）**：所有流向 `sugent-steward-mcp`、`OpsProjectionSink` 与 `PublicCanonPublisher` 的数据必须经过 `ProjectPrivacyRegistry`（原子持久化至 `<dataDir>/sugent-stewardship/project-privacy.json`，`0o700`/`0o600`）。系统先依据中英文敏感词根（`wallet|vault|secret|credential|career|accounting|private-key|简历|财务|账本|密钥|合同|薪资|私密|客户台账` 及未注册外置盘）与治理锚点（`ROADMAP.md`、`TASKS.md`、`TOMBSTONES.md`、`.agents`、`PROJECT.md`）做启发式初判（`tierSource: "heuristic"`），再允许用户随时调用 `setProjectTier(projectKey, tier)` 自由切换（`tierSource: "user_override"`），绝不锁死任何仓库：

1. `Tier 0`（静默脉搏，对应 `local_only`）：仅在本机留存索引与静默脉搏，MCP 与外部投影接口不读正文。
2. `Tier 1`（摘要雷达，对应 `metadata_only`）：仅放行脱敏 `projectKey`、状态枚举、任务计数与更新时间，剥离正文、绝对路径与人员姓名。
3. `Tier 2`（深度治理，对应 `summary_allowed`）：允许输出经敏感词清洗后的简短摘要或配合治理规则协同，向外部公共站发布仍须先展示本机 Diff 并校验主人确认哈希。

每次级位变更均会单调递增 `tierEpoch`。当发生降级或 `sanitizeForProjectTier` 遇到过期纪元（`incomingTierEpoch < current.tierEpoch`）载荷时，系统立即清空或拒收高阶正文防止历史队列复燃。同时保留本地绝对主权底线：`personal_life` 分区、证件号、密钥（`looksSecret` 拦截）与人脉雷区始终不出本机。

## 4. 近期 4 周实施排期、TDD 单测矩阵与验收门禁

### 4.1 四周增量排期（Sprint 1 ~ Sprint 4）

| 周期 | 交付模块与变更范围 | 复用既有模块 | 阶段验收判据 |
| :--- | :--- | :--- | :--- |
| Sprint 1（第 1 周） | 新增 `src/sugent/stewardship-ledger.ts` 与 `src/sugent/universal-dropzone.ts`，扩展 `types.ts` 增加 `"antigravity"` 源类型 | `knowledge-graph.ts`、`local-budget.ts`、`gateway.ts` | 四级信任阶梯升降级通过、`exclusive: true` 同步入图谱、公私分区物理隔离、四档分流与无工具 `HumanPrepBundle` 准备卡单测绿灯 |
| Sprint 2（第 2 周） | 新增 `src/sugent/proactive-cadence.ts` 与 `src/sugent/antigravity-bridge.ts`（含 `AntigravityStateReader`、`FleetPulseReader`、`ProjectPrivacyRegistry` 与 `AntigravityHookSink`），更新 `sources.ts` 第 4 内置源 `"antigravity"` | `kernel.ts`、`sources.ts`（`ZeroTokenProbeTracker`）、`receipt-protocol.ts` | 失衡扫描通过静态纯度门禁，每日软配额 `<= 2` 与 `filterSupersededBeforeSend` 二次销账生效，三表面 `?mode=ro` 扫库、SSH 别名剥离、`sessionRole` 区分、近 `48h` 截断、`.ops_fleet_state.json` 脉冲消费、动态隐私 `tierEpoch` 防复燃与插件目录 `<1ms` 短路全通过 |
| Sprint 3（第 3 周） | 补全 `antigravity-bridge.ts`（`ArtifactComprehensionPipeline`、`AntigravityDispatcher`、`PublicCanonPublisher` 与 `OpsProjectionSink`）与 `src/sugent/steward-mcp.ts`（收口进 `plugins/sugent-steward/`） | `security-envelope.ts`、`gateway.ts`、`causal-ledger.ts`、`Outbox`、`WeixinChannel` | `brain/` 制品全走 `0o400` 安全信封，`execFile` 仅限三个官方 `agentapi` 子命令，消费 `ProjectPrivacyRegistry` 动态隐私分级与 `tierEpoch`，8 跳熔断写因果账本与零私有网站硬编码静态检查通过 |
| Sprint 4（第 4 周） | 新增 `src/sugent/memory-gardener.ts`，落地 [`electron/main.ts`](../../electron/main.ts) 全局热键与托盘拖拽薄适配，更新 `src/sugent/index.ts`、`scripts/verify-sugent.mjs` 与 `package.json` | `knowledge-graph.ts`（`crystallizeSkillsToDir`）、`electron/main.ts`、`verify-sugent.mjs` | 周度提案单卡确认后正确写回 `.agents/rules/` 与 `TOMBSTONES.md`，`mode: "none"` 离线全流程可跑通，`verify:sugent` 全绿 |

### 4.2 TDD 单测矩阵

| 测试文件 | 核心断言与边界覆盖 |
| :--- | :--- |
| `test/sugent-stewardship-ledger.unit.test.ts` | 验证主目标并发上限 `<= 3`、`L3` 转正需 `verifiedObservations >= 3` 且支持口令秒降级、公私分区拦截及 `exclusive: true` 排他演化 |
| `test/sugent-universal-dropzone.unit.test.ts` | 验证 `capture` 一行回执、`recall` 档案检索、`advise` 墓碑告警、`delegate` 无工具场景产出完整 `HumanPrepBundle` |
| `test/sugent-proactive-cadence.unit.test.ts` | 静态门禁强制扫描零网络/零文件/零时钟/零随机数/零供应商名，验证每日配额上限 `2`、免打扰折叠、`urgent` 舰队脉冲直通去重、跨天留存队列与 `filterSupersededBeforeSend` / `drainMorningDigest` 二次销账 |
| `test/sugent-antigravity-reader.unit.test.ts` | 临时 SQLite 夹具验证三表面（`app \| cli \| ide`）`?mode=ro` 打开与 `(nodeId, surface, conversationId)` 标识、`canonicalizeProjectKey` 剥离 SSH 别名与 `.ops-project.json`、三类 `sessionRole` 静默、`.ops_fleet_state.json` 脉冲解析、近 `48h` 与 `bootstrappedAt` 截断、`ProjectPrivacyRegistry` 启发式初判/`user_override`/`tierEpoch` 防复燃，以及 `plugins/sugent-steward/{plugin.json,hooks.json}` 防覆写和 `<1ms` 子代理短路 |
| `test/sugent-antigravity-bridge.unit.test.ts` | 验证 `plugins/sugent-steward/hooks.json` 非阻塞返回 `{"decision":"allow"}`、`0o400` 防注入信封、`execFile` 参数数组调用 3 个 `agentapi` 子命令、8 跳熔断及零私人站名硬编码扫描 |
| `test/sugent-steward-mcp.unit.test.ts` | 验证四个 MCP 工具契约、动态 `Tier 0/1/2` 门禁拦截与 `tierEpoch` 降级校验及 `dryRunDiff` 盖印 |
| `test/sugent-memory-gardener.unit.test.ts` | 验证本周已验收 `walkthrough.md` 与微信驳回批注合并为单张周度提案卡，确认后写入 `.agents/rules/`、`TOMBSTONES.md` 及技能结晶 |

### 4.3 仓库门禁验收标准

每个 Sprint 合入 `main` 前，必须在本地运行以下三条命令且全部返回退出码 `0`：

1. `npm run typecheck`：TypeScript 严格类型检查零报错。
2. `npm run test:sugent`：上述 7 份新增单测并入 [`package.json`](../../package.json) `test:sugent` 脚本后 100% 通过，无跳过用例。
3. `npm run verify:sugent`：完成生产编译、[`scripts/verify-sugent.mjs`](../../scripts/verify-sugent.mjs) 契约断言（含 `mode: "none"` 免登录本地主权验证与动态隐私分级 `tierEpoch` 门禁）以及 `npm run docs:check` 链接巡检。
