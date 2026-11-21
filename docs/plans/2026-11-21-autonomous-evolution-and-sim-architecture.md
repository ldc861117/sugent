# Sugent 下一代双环自治与持续自我演化架构方案（SIM + 认知门控 + 离线园丁）

**Goal:** 在严守 [`AGENTS.md`](../../AGENTS.md) 零侵入边界与 [`PHILOSOPHY.md`](../PHILOSOPHY.md) 注意力经济学前提下，补齐 Sugent 从「事务型调度基建」到「跨 BYOK 模型持续自我演化闭环」的缺失链条，落地 `salience-gate.ts`、`executive-arbiter.ts`、`self-improvement-memory.ts` 与 `memory-gardener.ts` 四个核心模块，并打通现有未接线宿主通路。

**Architecture:** 方案融合四路实证结论：[`01 基线审计`](../../research/2026-11-21-autonomy-and-evolution/01-sugent-baseline-audit.md)（48 个 `src/sugent/*.ts` 文件与 5 个结构瓶颈）、[`02 YAN 挖掘`](../../research/2026-11-21-autonomy-and-evolution/02-multi-agent-brain-mining.md)（剥离生物拟人膨胀后的可用纯逻辑）、[`03 DSH 剖析`](../../research/2026-11-21-autonomy-and-evolution/03-dsh-and-superagent-analysis.md)（Cordis 插件钩子与 `dsh-superagent` 事务管道）及 [`04 Google SIM 论文拆解`](../../research/2026-11-21-autonomy-and-evolution/04-google-sim-crsi-2611-18856.md)（arXiv:2611.18856）。所有新增领域逻辑落入 `src/sugent/`，运行时只挂载 `dsh-runtime/plugins/` 与宿主薄适配，绝不改写上游 `src/channels/`、`src/tasks/service.ts` 或 `packages/dsh-superagent/`。

**Tech Stack:** TypeScript 5.x (ESM / `NodeNext`)、Node.js >= 22.13（`node:crypto`、`node:fs`、`node:sqlite`）、`@deepseek-ai/dsh` Cordis 插件总线、Vitest、`npm run verify:sugent`。

---

## 0. 商业策略自省四问（AGENTS.md 强制门禁）

开工编码前，按 [`AGENTS.md`](../../AGENTS.md) 第 3 节逐项核验本架构的商业与合规边界：

| 自省维度 | 核心拷问 | 本方案的落位与守线措施 |
| :--- | :--- | :--- |
| **1. 付费锚点**（Why Pay & Moat） | 哪些留作开源引流，哪些构成商业溢价？对比 WorkBuddy、千问办公优势在哪？ | **开源引流基座**：`salience-gate.ts` 降噪分流、`executive-arbiter.ts` 本地配额/专注仲裁、`SugentSIMStore` 本机问题经验账本与 `memory-gardener.ts` 单机整理全部开源。**商业付费增值**：基于 E2EE 同步（[`P2 方案`](./2026-11-12-p2-byok-diagnostics-and-e2ee-sync.md)）跨设备漫游经过验证的 SIM 演进记忆与 `SKILL.md` 资产包、[`Auth Broker`](./2026-11-12-p0-sugent-auth-broker.md) 驱动的外出微信/飞书高危回滚拍板中继，以及团队 `business-level-cowork` 经 Staging 审校的跨模型经验库。相比绑定单一家云生态的办公套件，Sugent 让用户自由切换 DeepSeek / Claude / Gemini / Ollama（BYOK）而不丢历史改造成果，且私人档案、证伪墓碑与预算红线全程不出本机。 |
| **2. 合规与分发**（Distribution & ToS Risk） | 能否通过 macOS 公证、Windows 签名与企业安全审计？是否有硬编码密钥或封号风险？ | `salience-gate.ts`、`executive-arbiter.ts` 与 `SugentSIMStore` 均属纯 TypeScript 逻辑与本机 `<dataDir>` JSON/JSONL 存储，零外部网络请求、零隐藏后台守护进程、零硬编码密钥。打包态（`app.asar`）延续 [`self-evolution.ts`](../../src/sugent/self-evolution.ts) 规则：只读黄金镜像永不改写，热插件与技能演进严格限定在 `<dataDir>/self-repo/extensions/` 且由 [`amb-self-edit-gate.mjs`](../../dsh-runtime/plugins/amb-self-edit-gate.mjs) 在 `tools/pre-execute` 拦截越界写盘；实验性适配器（如 `gemini-web2api`）保持隔离，不作为演化链路依赖。 |
| **3. 离线退路**（Sovereignty Fallback） | 剥离云端账号、断网或切到 `mode: "none"` 后，核心闭环能否独立运转？ | `SugentSIMStore`（`<dataDir>/self-evolution-sim.json`）直接向进化提示词注入完整紧凑 JSON，不依赖云端向量库或远程检索服务；配合本地 Ollama 与 [`local-budget.ts`](../../src/sugent/local-budget.ts) 的 `LocalBudgetLedger`，断网或在 `mode: "none"` 免登录状态下，预检降噪、执行仲裁、SIM 跨模型复验、外科式回滚与离线记忆园丁均可 100% 本机闭环运行。 |
| **4. 一人公司运维杠杆**（OPC Ops Leverage） | 是否满足「无状态边缘服务 + 端侧重逻辑」，保持接近零云端运维成本？ | 全部显著性打分、EMA 工具可靠性统计、SIM 回归判定与图谱修剪在端侧本地完成，不新增任何云端数据库或在线推理中台。空闲期通过 `ZeroTokenProbeTracker` 与 [`receipt-protocol.ts`](../../src/sugent/receipt-protocol.ts) `SuspendedRoundStore` 保持 0 进程、0 Token 消耗；`memory-gardener.ts` 采用三档 Cost Cap 路由（`<0.2` 纯确定性脚本，`0.2–0.5` 模板摘要，`>=0.5` 单次预算封顶 `steward` 调用），避免后台空转烧毁 BYOK 额度。 |

---

## 1. 四源能力对比矩阵

下表将 Sugent 当前底座与 `multi-agent-brain`（YAN）、DeepSeek Harness + `dsh-superagent`、Google SIM/CRSI（`arXiv:2611.18856`）在六个自治维度上逐项对齐，标明各自长板与 Sugent 的实际缺口。

| 能力维度 | Sugent 当前基线（`70a80a9`） | `multi-agent-brain`（YAN） | DSH & `dsh-superagent` | Google SIM / CRSI（`arXiv:2611.18856`） |
| :--- | :--- | :--- | :--- | :--- |
| **1. 感知与显著性门控** | [`ZeroTokenProbeTracker`](../../src/sugent/sources.ts) 仅做二进制 SHA-256 哈希比对；[`universal-dropzone.ts`](../../src/sugent/universal-dropzone.ts) 靠静态正则分流；无连续意外度/目标相关性打分；`evaluatePersonalTrigger` 与 `TriggerCoalescer` 尚未接入 `App` 主循环。 | `WorldDeltaCalculator` 零 LLM 结构化 diff；`SalienceGate` 4 维加权打分（预测误差 `0.40`+驱力 `0.25`+情绪 `0.20`+新奇 `0.15`）及动态阈值；`template_perceive()` 零 Token 快路径。 | `SourceRegistry.scope()` 过滤越界来源；`Gate` 白名单/提及判定 + `MasterAssessor`（`off/observe/auto`）语义初筛；缺介于探针与 LLM 之间的连续打分器。 | 运行前无事件显著性门控，聚焦于演化轮次中的 Evaluator 样本轨迹与未通过任务误差信号 $F_t$。 |
| **2. 执行聚焦与状态机仲裁** | 宿主 `pickRuns()` 仅按 4 档 FIFO 抢占槽位；[`stewardship-ledger.ts`](../../src/sugent/stewardship-ledger.ts) 限制 `MAX_ACTIVE_GOALS = 3` 但未参与任务调度；`VibeCodingPipelineOrchestrator` 与 `AntigravityDispatcher` 绕过统一槽位并发竞争；[`SuspendedRoundStore`](../../src/sugent/receipt-protocol.ts) 实现零进程挂起与 `8` 跳熔断。 | `ExecutiveOrchestrator`（`MAX_DELIBERATION_PER_GOAL = 3`、300s 冷却）、`FocusManager`（切换惯性与 5 阶段超时）、`InterruptionGate`（上限 50 队列）、`SomaticSecurityGate` + `SomaticMarkerStore`（分错误类型 EMA），但运行时多被 `CoordinationAgent` 绕过且受困于 `BioCore` 过载。 | `Engine` 在 SQLite `Store.atomic()` 内驱动 `Intake -> Eval -> Mandate -> Ticket -> Assignment -> Outbox`；`WorkerSlots` 预留 `+1` 人工追问槽位；`DshExecutor` 绑隔离 worktree 与 `TRANSIENT_TRIES = 3`；无跨目标优先级与用户预算感知。 | 将复杂运行限制为单轮 $N=10$ / $k=5$ 离线演化评估，依靠 Selector $\mathcal{S}$ 预筛选候选 Harness 并权衡性能与复杂度，不负责日常实时多任务并发调度。 |
| **3. 记忆架构与离线整理** | [`knowledge-graph.ts`](../../src/sugent/knowledge-graph.ts) 支持 `exclusive: true` 边取代、CJK 2-hop 召回及 `>= 3` 次结晶 `SKILL.md`；但存在 `sugent-kg`（`App`）与 `knowledge-graph`（`AgentManager`）双库分裂、`ops.remove` 未实现，且 `memory-gardener.ts` 仅在路线图规划中未落地。 | `SharedMemory`（Milvus 13 集合，曾因漏初始化崩 690 次）属重资产反例；但 `DreamSandbox`（`PROPOSED -> 3x VALIDATED / 7d DISCARDED`）、Titans 动量意外度（`>= 0.7` 立即触发）与 `AdaptiveCoherentizer`（三档成本路由）高度可复用。 | 内部三层 `MEMORY.md` + `BasicCompactionEngine`（0.8 压力压缩 + 0.16 保留 + KV 缓存前缀复用）+ `amb-memory.mjs`（90s 空闲 `steward` 触发 `compactNow`/`switchSegment`）；`dsh-superagent` SQLite 表只增不清理。 | **刻意区分两层记忆**：明确把 SIM 隔离为「外环 Harness 优化器记忆 $\mathcal{M}_t$」，不污染任务策略 $M$ 的日常工作上下文；采用全量紧凑 JSON 注入，省去向量检索误差。 |
| **4. 自我演化闭环与跨模型留存** | [`self-evolution.ts`](../../src/sugent/self-evolution.ts) 守住源码 Git / 打包 `extensions/` 物理隔离；[`causal-ledger.ts`](../../src/sugent/causal-ledger.ts) 记录哈希链轮次事实，但缺 `modelId`、`editRationale`、预期-实际偏差与失败聚类；[`gateway.ts`](../../src/sugent/gateway.ts) 切 BYOK 模型后无重验证机制。 | `RuleEngine`（上限 50 条、EMA 有效性更新、0.995 衰减）+ `MemoryEnvelope`（SHA-256 `Trace` 与 `model_version`/`prompt_hash` `MeaningLayer` 分离）；但无确认即热改核心特质向量导致失控。 | `dsh-experimental-auto-review`、`amb-control.mjs` 单行切模型提示、[`knowledge-graph.ts`](../../src/sugent/knowledge-graph.ts) 按次数自动写 `SKILL.md`；缺乏「改动假设—预测指标—跨模型验证」闭环，仍属 Harness-Only 续接。 | **核心突破**：按问题族 $c_i$ 聚合尝试序列 $(a_{ij}, o_{ij}, p_{ij})$（含已回退/未解记录）及可移植性分类（Table 8）；在 Opus 5.5 -> Gemini 3.8 Flash 跨模型迁移中 4/4 全胜（最高 `+11.33` 分），10 组配对实验 9 胜（$p=0.003$）。 |
| **5. 人物与心智/关系建模** | `StewardshipLedger` 的 `RelationshipProfile` 支持 `L0`–`L3` 信任阶梯（`TRUST_PROMOTE_THRESHOLD = 3` + `ownerConfirmed`）与 `taboos`/`preferences`/`openFavors`；[`concierge-subgraph.ts`](../../src/sugent/concierge-subgraph.ts) 实现跨联系人子图隔离；软品味全靠人工录入或 LLM 总结。 | `LanguageProfiler`（零 LLM 统计词频衰减、平均句长、正式度与表情密度）、`IdentityIntegrator` + `MergeGuard`（强/弱匹配区分，需 `>= 2` 强证据才合并身份）；`MetaCognitionEngine` 四步观察目标与行为背离。 | 仅保留 `allowedSender` 白名单与 `Gate` 成员身份检查，完全无长期人脉语境、说话品味或目标背离审查。 | 论文聚焦客观评测基准（编程、分类、办公、工程设计），不涉及个人关系图谱或人际避雷建模。 |
| **6. 安全沙箱与回归回滚** | [`security-envelope.ts`](../../src/sugent/security-envelope.ts) `0o400` 只读隔离与越权字段剥离；[`concierge-guardrails.ts`](../../src/sugent/concierge-guardrails.ts) G1–G5 防社死锁；[`safe-relauncher.ts`](../../src/sugent/safe-relauncher.ts) 30s 启动探活回滚；但上线后行为退化无自动隔离，打包态 `resetSelfEvolutionOverlay()` 会整包清空全部插件。 | `BrowserSafetyGate` / `EvidenceGate` 仅覆盖局部工具；缺乏隔离防注入信封，252 行夜间 Telegram 狂发幻觉消息；P48 反幻觉告警 201 次却不拦截执行。 | `amb-self-edit-gate.mjs` 在 `tools/pre-execute` 拦截禁区路径并强制打包态 Shell 走 `ask`；`amb-bridge.mjs` 隔离文件读写；均属**执行前门控**，无上线后效果衰退触发的精准单点下架。 | 保留被替代的历史失败尝试（如 `P8` R4 拦截逻辑被撤但记录仍留在 $\mathcal{M}$）+ 基于 held-out 与 evolve 集客观通过率对比的 Selector $\mathcal{S}$ 准入门控。 |

---

## 2. 明确的 Borrow / Adapt / Discard 决策

### 2.1 从 `multi-agent-brain`（YAN）中严格筛选：借什么、怎么改、扔掉什么

`multi-agent-brain` 最终膨胀到 `agents/` 下 **65 个子目录、430 个 Python 文件**，在 2026-01-06 夜间事故中暴露了自检顺序倒置（`EXISTENTIAL_ANXIETY` 触发 1,751 次而内部对话 0 次）、夜间结晶饿死（`PROCESS_MESSAGE` 占满 1,677 次把 `NIGHT_CRYSTALLIZATION` 挤到 14 次）、Milvus 集合漏建崩溃 690 次及 `social_need > 0.55` 触发 252 行 Telegram 刷屏。造成瘫痪的根源在于它**围着人造生物激素生长，偏离了「围着具体主人」的设计目标**。据此作出刚性切分：

| 处置决策 | YAN 原型模块与机制 | Sugent 目标落位与工程改造规则 |
| :--- | :--- | :--- |
| **Borrow & Adapt** | `WorldDeltaCalculator` + `SalienceGate` + `template_perceive()` | 改写为纯函数 [`src/sugent/salience-gate.ts`](#31-内环实时自治流水线)。把 YAN 的生物驱力权重换成**主人北极星匹配度（`0.35`）+ 因果预测偏差（`0.30`）+ 状态跳变幅度（`0.20`）+ 承诺临期度（`0.15`）**；在低预算或免打扰时段自动抬高阈值，低于阈值输出 0 Token 模板摘要，不唤醒 `assessor`。 |
| **Borrow & Adapt** | `SomaticSecurityGate` + `CognitiveLoadManager` + `SomaticMarkerStore` | 剥离「AI 情绪疲劳/精力耗竭」隐喻，改造为 [`src/sugent/executive-arbiter.ts`](#31-内环实时自治流水线) 的**三维现实资源闸门**（主人注意力时间窗 + `LocalBudgetLedger` 美元余量 + `TrustTier L0–L3` 与风险等级）和 **`ToolReliabilityLedger`**。原封借鉴 `ErrorCategory` 区分 `TRANSIENT`（`-1.0`）、`NOT_FOUND`（`-0.3`）与 `POLICY`（不扣工具可靠性分），防止安全护栏正常拦截误伤工具健康度。 |
| **Borrow & Adapt** | `ExecutiveOrchestrator` 死循环护栏 + `FocusManager` 惯性 + `InterruptionGate` + `CommitmentPolicy` | 改造为 `executive-arbiter.ts` 的并发槽位与队列仲裁：复用 `MAX_DELIBERATION_PER_GOAL = 3`、`DELIBERATION_COOLDOWN_SECONDS = 300`、优先级有界积压队列（上限 50）与基于北极星对齐度/截止期/可靠性的续跑决策，统一约束 `TaskService`、`VibeCodingPipelineOrchestrator` 与 `AntigravityDispatcher`。 |
| **Borrow & Adapt** | `DreamSandbox` + Titans 动量意外度 + `AdaptiveCoherentizer` + `MetaCognitionEngine` + `RuleEngine` | 共同落入 [`src/sugent/memory-gardener.ts`](#32-外环持续演化闭环)。保留 `PROPOSED (0.3) -> 3 次实地印证转正 / 2 次驳回或 7 天过期 DISCARDED` 沙盒状态机、Titans `surpriseMomentum >= 0.7` 异常插队、三档 Token 预算上限（`<0.2 / 0.2–0.5 / >=0.5`）、目标-行动偏差扫描与规则 EMA 退化降级（`act -> observe`）。 |
| **Borrow & Adapt** | `LanguageProfiler` + `IdentityIntegrator`/`MergeGuard` + `MemoryEnvelope` | 落入 `memory-gardener.ts` 与 `StewardshipLedger` / `SugentKnowledgeGraph`：零 LLM 提取通信简练度与正式度喂给 `RelationshipProfile.preferences`；跨微信/飞书联系人合并强制要求 `>= 2` 项强证据；沿用 `Trace`（不可变 SHA-256）与带 `(modelId, promptHash)` 的 `MeaningLayer` 分离原则。 |
| **Strictly Discard** | `BioCore` 6 层激素与人格模式切换（`biocore.py` 1,173 行）、`social_need > 0.55` 主动搭讪、RPG 房间/访客/幻想循环（`CovertExperienceLoop`）、每 5 秒/300 秒内省独白、65 目录 Milvus + Redis + `rdflib` 重栈、未经确认热改 `TraitVector` | **永久禁入 Sugent**。主动触达只允许来自可核验账本失衡或外部真实事件，且受每日 `<= 2` 软配额硬锁；闲置期保持 0 驻留进程与 0 LLM Token；任何规则或身份偏好变更必须经过 `observe -> act` 满 3 次或单张主人确认卡。 |

### 2.2 零侵入复用 DSH 与 `dsh-superagent` 的工程边界

[`03 DSH 剖析`](../../research/2026-11-21-autonomy-and-evolution/03-dsh-and-superagent-analysis.md)证实，`packages/dsh-superagent/` 的 `Engine`（`Intake -> Eval -> Mandate -> Ticket -> Assignment -> Outbox`）与 DSH 运行时（`@deepseek-ai/dsh@0.2.1-rc.4`）已经把单轮事务可靠性与防上下文溢出做到很高水准。Sugent 不去 fork 或改写这两棵上游树，而是只通过三处既有接缝把能力接进闭环：

1. Cordis 运行时钩子（`dsh-runtime/plugins/`）：`amb-control.mjs` 已在 `agent/created` 与 `agent/pre-step` 捕获模型切换，`amb-prompt.mjs` 在 `system-prompt/assemble`（`amb:bot`）注入系统上下文，`amb-memory.mjs` 在 `agent/status`（`idle`）唤醒 Context Steward，`amb-self-edit-gate.mjs` 在 `tools/pre-execute` 校验写权限。新增演化归因只在插件层读取 `tools/result`、`agent/error`、`agent/turn-stopping` 与 `agent/status` 遥测，不改 `@deepseek-ai/dsh` 源码。
2. `AgentHost` 装配注入（[`src/agent/host.ts`](../../src/agent/host.ts)）：继续由 `writePatch()` 生成 `amb.patch.yml` 并通过 `selfEvolutionPluginLines()` 挂载用户级 `sugent-ext-<slug>`（`apiVersion: 1`）扩展插件，保证 `npm run sync:upstreams:merge` 长期零冲突。
3. 补齐 Tier-2 未接线断点（[`01 基线审计` §1.2](../../research/2026-11-21-autonomy-and-evolution/01-sugent-baseline-audit.md)）：当前 `evaluatePersonalTrigger`、`createEnvelopedRuleEventSink`、`TriggerCoalescer`、`scanCadence`/`drainMorning` 周期定时器与 `VibeCodingPipelineOrchestrator` 内的 `causalLedger` 注入都还处于"库已单测、宿主 `App` 未全量串联"的状态，且存在 `App`（`<dataDir>/sugent-kg`）与 `AgentManager`（`<dataDir>/knowledge-graph`）双图谱分裂。先闭合这批宿主薄接线，再挂入新环。

### 2.3 为什么 Google SIM（arXiv:2611.18856）能根治 BYOK 切模型失忆

Sugent 在生产环境里天然处于论文定义的**持续递归自我演化（CRSI）**工况——哪怕只有一台笔记本上的单人用户：
- **高频换模（$M_S \neq M_T$）**：[`gateway.ts`](../../src/sugent/gateway.ts) 配合 [`provider-registry.ts`](../../src/sugent/provider-registry.ts) 的 10 种提供商预设，允许用户随时把 `executor` 从 Claude Sonnet 4.5 切到 DeepSeek、Gemini 或本地 Ollama，甚至四个角色同轮混用不同模型（对应论文 `S2` 统一合成工况）。
- **多源任务漂移（$\mathcal{X}_S \neq \mathcal{X}_T$）**：[`types.ts`](../../src/sugent/types.ts) 定义 8 类个人事件源。在代码仓（`github`/`antigravity`）结晶出的完成检查，套用到日常沟通或政务事务（`im_channel`/`mail_calendar`）就会出现论文附录 F.2 揭示的 `P5 -> P8`（过关但非最优/契约错配）退化。

Google 实证证明：**只传改后的 Harness 代码而不带演进记忆（Harness-Only Continuation）会导致灾难性负迁移**——Claude Opus 5.5 演化出的 Harness 直接切给 Gemini 3.8 Flash，在 4 个测试域起步全低于未演化种子（`-0.60` 至 `-5.48` 分），其中 3 个域跑完 10 轮仍跑输从零开始；而 **Full SIM** 在 4/4 跨模型迁移全胜（最高 `+11.33` 分）并在 10 组配对实验赢下 9 组（$p=0.003$）。原因就在 Sugent 目前只记「改了哪些文件（`SelfEvolutionPlan`）」和「重复了 3 次（`SKILL_CRYSTALLIZE_THRESHOLD = 3`）」，没记**针对什么问题 $c_i$、为什么改 $a_{ij}$、预测修好什么 vs 实际修好什么 $o_{ij}$、在哪个 `(role, modelId)` 上验证通过 $p_{ij}$**。引入 `SugentSIMStore` 并按论文 Table 8 给每项规则/技能/插件打上 `interface_invariant | threshold_tunable | model_specific` 可移植性标签后，切模型时能精准重验局部脆弱规则，失败时做单件外科手术回滚，不再调用全量清盘的 `resetSelfEvolutionOverlay()`。

---

## 3. 下一代 Sugent 双环自治与演化架构

整个升级严格落在 [`src/sugent/`](../../src/sugent/)（4 个新增模块 + 4 处最小契约扩展）与 [`dsh-runtime/plugins/`](../../dsh-runtime/plugins/)，形成**内环毫秒级/单轮自治**与**外环跨轮次/周级自我演化**咬合的双闭环：

```text
  [外部事件 / Antigravity / Cron / Dropzone]
        │
        ▼ (0 Token 哈希过滤)
  ZeroTokenProbeTracker (sources.ts)
        │ diff_detected
        ▼ (0 Token 结构化增量与 4 维打分)
  salience-gate.ts ──(< 动态阈值)──▶ templateDigest -> morningDigestQueue / Ledger (0 LLM)
        │ (>= 动态阈值)
        ▼
  kernel.ts + dsh-superagent Intake/Eval + executive-arbiter.ts (注意力窗/USD预算/TrustTier/工具EMA)
        │ 放行执行 (assessor / executor / computer_use)
        ▼
  DSH Session / Vibe Worktree / AntigravityDispatcher ──▶ CausalLedger (含 resolvedModelId & 偏差)
        │                                                       │
        ├──(意外度 >= 0.7 或 行为退化)──────────────────────────┤
        ▼                                                       ▼
  self-improvement-memory.ts (SugentSIMStore) ◀──────── memory-gardener.ts (周度/空闲整理)
    • 问题簇 P# -> 动机/假设/预测vs实际偏差/模型上下文     • Goal-vs-Action 偏差 & 规则 EMA 退化降级
    • BYOK 切模型重验队列 & 单件外科回滚                   • DreamSandbox (3次印证转正 / 7天淘汰) + 墓碑结晶
    • 仅注入 Proposer/Selector (steward/executor)         • LanguageProfiler 软品味 + 统一 KG ops.remove 修剪
```

### 3.1 内环：实时自治流水线

#### A. 零 LLM 结构增量与认知显著性门控（`src/sugent/salience-gate.ts`）

介于 [`ZeroTokenProbeTracker`](../../src/sugent/sources.ts) 与 `assessor` 模型之间，严守 [`kernel.ts`](../../src/sugent/kernel.ts) 纯函数铁律（零 FS/网络/时钟/`Math.random`），先算结构化差异，再决定是 0 Token 生成 `templateDigest` 还是唤醒 LLM：

```typescript
import type { BotBudgetStatus } from "./local-budget.js";
import type { CadenceBudgetState } from "./proactive-cadence.js";
import type { LedgerSnapshot } from "./stewardship-ledger.js";
import type { PersonalTrigger } from "./types.js";

export type SalienceBand = "NOISE" | "NOTICE" | "IMPORTANT" | "CRITICAL";

export interface EventWorldDelta {
  key: string;                 // threadKey 或 projectKey
  addedKeys: string[];
  removedKeys: string[];
  changedFields: Array<{ field: string; from?: unknown; to?: unknown }>;
  magnitude: number;           // 0..1 归一化结构变化度
  elapsedMsSinceLastSeen: number;
}

export interface SalienceInput {
  trigger: PersonalTrigger;
  delta: EventWorldDelta;
  ledger: Pick<LedgerSnapshot, "goals" | "commitments" | "guardrails">;
  budgetStatus: BotBudgetStatus;
  cadenceState: Pick<CadenceBudgetState, "quietHoursActive" | "nonUrgentSentCount" | "dailySoftQuota">;
  expectedOutcomeMatch?: number; // 来自 CausalLedger 的预测偏差 0..1
  nowIso: string;
}

export interface SalienceVerdict {
  score: number;               // 0..1 综合分：goal(0.35)+error(0.30)+novelty(0.20)+urgency(0.15)
  effectiveThreshold: number;  // 基础 0.35，低预算/免打扰/超配额时动态上抬，钳位 [0.30, 0.90]
  band: SalienceBand;
  route: "drop_noise" | "fast_template_digest" | "wake_assessor" | "fast_escalate_owner";
  templateDigest?: string;     // fast_template_digest 模式下 0 Token 落入账本/早报
  matchedGoalIds: string[];
}

export function computeEventDelta(prevPayload: Record<string, unknown> | undefined, nextPayload: Record<string, unknown>, key: string, elapsedMs: number): EventWorldDelta;
export function scoreEventSalience(input: SalienceInput): SalienceVerdict;
```

#### B. 统一执行仲裁器与工具可靠性账本（`src/sugent/executive-arbiter.ts`）

将 YAN `SomaticSecurityGate`、`SomaticMarkerStore`、`FocusManager` 与 `InterruptionGate` 转译为**以主人注意力、美元余量与工具历史可靠度为核心**的确定性仲裁层，统一收口 `TaskService`、`VibeCodingPipelineOrchestrator` 与 `AntigravityDispatcher`：

```typescript
import type { BotBudgetStatus } from "./local-budget.js";
import type { CadenceBudgetState } from "./proactive-cadence.js";
import type { EvolutionRiskLevel } from "./self-evolution.js";
import type { TrustTier } from "./stewardship-ledger.js";
import type { EvalDecision, ModelRole } from "./types.js";

export type ToolErrorCategory = "TRANSIENT" | "NOT_FOUND" | "POLICY";

export interface ToolReliabilityRecord {
  toolKey: string;             // 形如 "cli:agentapi" 或 "role:executor:deepseek/deepseek-chat"
  emaScore: number;            // [-0.5, 1.0]，alpha = 0.1，每日衰减 0.95；POLICY 错误不扣分
  sampleCount: number;         // >= 5 才解除冷启动保护
  lastCategory?: ToolErrorCategory;
  updatedAtIso: string;
}

export interface ExecutionBudgetContext {
  evalDecision: EvalDecision;
  trustTier: TrustTier;
  riskLevel: EvolutionRiskLevel;
  budgetStatus: BotBudgetStatus;
  cadenceState: Pick<CadenceBudgetState, "quietHoursActive" | "nonUrgentSentCount" | "dailySoftQuota">;
  activeOwnerTimeWindow: boolean;
  goalId?: string;
  recentDeliberationsForGoal: number; // 上限 MAX_DELIBERATION_PER_GOAL = 3
  cooldownRemainingSec: number;       // DELIBERATION_COOLDOWN_SECONDS = 300
  activeSlotsByGoal: Record<string, number>;
  toolReliability?: ToolReliabilityRecord;
}

export type ArbitrationAction =
  | "ALLOW_EXECUTE"
  | "DOWNGRADE_TO_ASSESSOR"   // 低预算余量时把多步 executor 降档为低耗 assessor
  | "SUSPEND_FOR_APPROVAL"    // L0/L1/L2 或高风险路径写入 SuspendedRoundStore 挂起
  | "DEFER_TO_MORNING_DIGEST" // 免打扰/非主动窗期且非紧急事件，入有界优先队列 (max 50)
  | "HALT_COOLDOWN_OR_BUDGET";// 预算耗尽或同一目标 300s 内连续审议超 3 次，硬止损

export interface ArbitrationVerdict {
  action: ArbitrationAction;
  recommendedRole: ModelRole;
  reasonCode: string;
  retryAfterSec?: number;
}

export function evaluateExecutionBudgetGate(ctx: ExecutionBudgetContext): ArbitrationVerdict;
export function updateToolReliabilityEma(prev: ToolReliabilityRecord | undefined, toolKey: string, succeeded: boolean, category: ToolErrorCategory | undefined, nowIso: string): ToolReliabilityRecord;
```

#### C. 先查后问追问闭环与目标引力场（`src/sugent/clarification-gate.ts` + `proactive-cadence.ts`）

废除机械的「每日最多 2 次」限制，升级为「信息净收益 × 心流边界博弈 + 先翻家底单点追问 + 目标引力场」：
- `clarification-gate.ts`：先校验 `activeGoals`（匹配主航道归入 `north_star`、显式承诺归入 `commitment_maintenance`、无关联突发脑洞默认进 `icebox` 不抢资源）；在 `delegate` 或设立主目标前执行 Recall-Before-Ask，识别重名联系人、未定高危报价/转账槽位、空心化北极星判据或 `tombstone` 碰撞，只抛 1 个附 A/B 选项的问题并把不依赖答案的本地档案先行备好（同题最多 2 轮）。
- `proactive-cadence.ts`：`DEFAULT_DAILY_NON_URGENT_QUOTA = 0`（默认不按总次数封顶），新增 `evaluateFlowAwareDelivery()` 与 `drainBoundaryQueue()`（同频共创立即互动，异构深潜心流压入 `boundaryQueue` 待窗口/步骤切换投递，同题设退避冷却）、`collectRealtimeGoalDrift()`（小时级偏航提醒）与 `collectGoalStagnationUnblock()`（主目标连续 3 轮低收益卡壳自动拆最小破局动作）。

### 3.2 外环：持续演化闭环

#### A. 自我改进记忆账本与跨模型外科回滚（`src/sugent/self-improvement-memory.ts`）

严格遵循 `arXiv:2611.18856` §3.2 边界：**`SugentSIMStore` 只服务外环演化优化器（`self-evolution.ts`、`memory-gardener.ts` 与 `steward`），绝不污染日常任务会话上下文**。默认向 Proposer/Selector 注入完整紧凑 JSON（`<dataDir>/self-evolution-sim.json`，`0o600` 原子写），无需外部向量库。

```typescript
import type { ModelRole, PersonalSourceKindId } from "./types.js";

export type SimArtifactKind = "skill_md" | "proactive_rule" | "cordis_plugin" | "role_prompt";
export type SimPortabilityClass = "interface_invariant" | "threshold_tunable" | "model_specific";

export interface SimProvenanceContext {
  modelRole: ModelRole;
  resolvedModelId: string;         // 来自 gateway.ts selectModelForRole()
  providerPreset?: string;         // 来自 provider-registry.ts ProviderRecord.preset
  sourceKind?: PersonalSourceKindId;
  ruleVersion?: number;
}

export interface SimOutcomeDelta {
  predictedOutcomes: string[];     // 改动前声明预期修复的问题或指标
  fixed: string[];                 // 实际被验证修复的案例/roundId
  missed: string[];                // 仍未解决或复现的案例
  baselinePassRate?: number;
  postEditPassRate?: number;
  ownerRejectedCount: number;      // 来自 CausalLedger approval_decided(approved=false)
  regressionDetected: boolean;
}

export interface SimEditAttempt {
  attemptId: string;
  roundId: string;                 // 关联 causal-ledger.ts 哈希链轮次
  atIso: string;
  artifactKind: SimArtifactKind;
  artifactPathOrId: string;        // 如 skills/<name>/SKILL.md、sugent-ext-<slug>、rule:<id>
  portabilityClass: SimPortabilityClass;
  rationale: string;               // 为什么改（对应 paper a_ij.what）
  hypothesis: string;              // 可证伪预期假设
  accepted: boolean;
  revalidationStatus: "verified" | "needs_revalidation" | "quarantined" | "reverted";
  outcomeDelta: SimOutcomeDelta;
  provenance: SimProvenanceContext;
  carriedFromAttemptId?: string;   // 跨模型/跨版本继承溯源
}

export interface SimProblemCluster {
  problemId: string;               // 如 "P-EXEC-001"
  title: string;
  aliases: string[];               // 确定性合并的同源问题编号
  openedAtIso: string;
  attempts: SimEditAttempt[];      // 只追加不删历史：已撤回改动依然保留，防止新模型重踩
}

export interface RegressionDecision {
  shouldQuarantine: boolean;
  artifactKind: SimArtifactKind;
  artifactPathOrId: string;
  reason: string;
  tombstoneStatement: string;      // 同步写入 StewardshipLedger(kind:"tombstone")
}

export class SugentSIMStore {
  recordAttempt(cluster: Pick<SimProblemCluster, "problemId" | "title">, attempt: SimEditAttempt): void;
  reconcileRoundOutcome(roundId: string, observed: Partial<SimOutcomeDelta>): SimEditAttempt | undefined;
  flagOnModelSwitch(role: ModelRole, prevModelId: string, nextModelId: string): SimEditAttempt[];
  evaluateRegression(attemptId: string): RegressionDecision | undefined;
  buildOptimizerPromptJson(maxEntries?: number): string;
}
```

**跨模型与回滚联动**：(1) [`causal-ledger.ts`](../../src/sugent/causal-ledger.ts) 的 `CausalFactInput` 增加可选 `resolvedModelId`、`providerPreset` 与 `simAttemptRef`，不再丢失实际执行的 BYOK 模型；(2) [`amb-control.mjs`](../../dsh-runtime/plugins/amb-control.mjs) 或 `gateway.ts` 检测到某角色切换模型时，调用 `flagOnModelSwitch()` 保留 `interface_invariant` 规则，仅把旧模型上的 `model_specific` / `threshold_tunable` 改动标为 `needs_revalidation`；(3) 发生回归（连续驳回、成本异常或跳数熔断升高）时，通过 `evaluateRegression()` 对单个 `SKILL.md` / `sugent-ext-*` 插件置为 `quarantined` 并移出激活列表、为 `ProactiveRulePolicy` 降级回 `observe`，同时在 `SugentSIMStore` 与 `ValueGuardrail` 保留墓碑，彻底取代全包清零的 `resetSelfEvolutionOverlay()`。

#### B. 离线记忆园丁与认知对齐巡检（`src/sugent/memory-gardener.ts`）

填补 [`docs/ROADMAP.md`](../ROADMAP.md) N3 规划空白并统一图谱分裂缺陷（把 `AgentManager` `<dataDir>/knowledge-graph` 收口进 `App` `<dataDir>/sugent-kg`，同时实现 `knowledge-graph.ts` 长期未落地的 `ops.remove` 边权削弱与清理）。园丁只在**周度周期校准（`periodic_calibration`）、空闲窗口或 Titans 意外度动量 `>= 0.7` 异常插队**时运行，彻底杜绝夜间定时独白：

```typescript
import type { RoundTraceProjection } from "./causal-ledger.js";
import type { KGDelta } from "./knowledge-graph.js";
import type { ContextPartition, LedgerSnapshot, RelationshipProfile } from "./stewardship-ledger.js";

export type GardenerCostTier = "tier0_deterministic" | "tier1_template" | "tier2_steward_llm";
export type HypothesisState = "PROPOSED" | "VALIDATED" | "DISCARDED";

export interface GardenerSandboxHypothesis {
  id: string;
  partition: ContextPartition;
  targetKind: "tombstone" | "skill_proposal" | "rule_demotion" | "goal_drift_alert";
  statement: string;
  state: HypothesisState;         // 初始 PROPOSED (confidence = 0.3)
  confirmations: number;           // 满 3 次现实印证 -> VALIDATED，推单张确认卡
  contradictions: number;          // 满 2 次驳回或超 7 天未印证 -> DISCARDED
  createdAtIso: string;
  lastEvidenceAtIso: string;
}

export interface GoalActionDriftReport {
  windowDays: number;
  activeGoalIds: string[];
  nonGoalRoundShare: number;       // 非主目标事务占比 > 0.70 时触发温和算账提示
  nonGoalCostShare: number;
  surpriseMomentum: number;        // Titans EMA：S_t = eta * S_{t-1} + (1-eta) * S_cur
  urgentTriggered: boolean;        // surpriseMomentum >= 0.70 时立即插队复盘
}

export interface LanguageTasteDelta {
  relationshipId: string;
  partition: ContextPartition;
  avgCharsEma: number;
  formalityScore: number;          // 0..1 零 LLM 词频/句式特征
  suggestedPreferences: string[];  // 仅写入 RelationshipProfile.preferences（soft_taste）
  mergeEvidenceCount: number;      // 跨渠道联系人合并强门禁：>= 2 项强证据
}

export interface GardenerCycleInput {
  nowIso: string;
  ledger: LedgerSnapshot;
  recentRounds: RoundTraceProjection[];
  acceptedWalkthroughs: Array<{ id: string; workspacePath: string; summary: string }>;
  recentMessagesByPeer: Record<string, string[]>;
  prevSurpriseMomentum: number;
  maxStewardTokenBudget: number;
}

export interface GardenerCycleOutput {
  costTier: GardenerCostTier;      // <0.2 确定性清理 | 0.2-0.5 模板摘要 | >=0.5 单次 steward LLM
  driftReport: GoalActionDriftReport;
  kgPruningDelta: KGDelta & { removeEdgeIds: string[] };
  promotedProposals: GardenerSandboxHypothesis[];
  demotedRuleIds: string[];        // EMA 信任衰减后从 act 退回 observe 的规则
  tasteUpdates: LanguageTasteDelta[];
  calibrationCardLines?: [string, string, string]; // 汇入 proactive-cadence.ts 每日 <=2 配额
}

export function runGardenerCycle(input: GardenerCycleInput): GardenerCycleOutput;
```

**核心工作流**：(1) **Goal-vs-Action 偏航审计**：对照 `GoalNorthStar`（上限 3 条）与 `CausalLedger` 近窗口耗时/花销占比，非主航道占比超 `70%` 时仅在 `periodic_calibration` 产出一行算账摘要；(2) **Sandbox 墓碑结晶**：从连续驳回与 `VibeCoding` 失败日志抽取候选墓碑进 `PROPOSED`，满 3 次印证或 `surpriseMomentum >= 0.7` 后汇入 `ValueGuardrail(kind: "tombstone")` 与仓内 `TOMBSTONES.md`；(3) **软品味与安全合号**：零 LLM 统计主人及联系人语句长度与正式度刷新 `RelationshipProfile.preferences`，跨平台身份合并必须过 `mergeEvidenceCount >= 2` 的 `MergeGuard`；(4) **三档成本封顶与规则降级**：`RuleEngine` EMA 信任度跌破阈值自动把失灵 `act` 规则退回 `observe`，并按 `<0.2 / 0.2–0.5 / >=0.5` 控制 `steward` 调用，严防空转耗尽 BYOK 额。

### 3.3 零侵入接线与双上游隔离表

为守住 `npm run sync:upstreams:merge` 长期零冲突，所有改动的物理落位严格划定如下：

| 层次 | 允许触碰的模块与文件 | 严禁改写的上游区域 |
| :--- | :--- | :--- |
| **Sugent 自研核心（`src/sugent/`）** | 新增 `salience-gate.ts`、`executive-arbiter.ts`、`self-improvement-memory.ts`、`memory-gardener.ts`；增量扩展 `causal-ledger.ts`、`self-evolution.ts`、`knowledge-graph.ts`（修通 `ops.remove`）、`stewardship-ledger.ts`、`vibe-coding-pipeline.ts`（接通 `causalLedger` 落盘）、`steward-host-service.ts`。 | 严禁在 `kernel.ts` / `salience-gate.ts` / `proactive-cadence.ts` / `executive-arbiter.ts` 纯函数核心引入 FS、网络、系统时钟、随机数或具体模型厂商名。 |
| **DSH Cordis 插件（`dsh-runtime/plugins/`）** | 在 `amb-control.mjs` 上报 `resolvedModelId` 并订阅 `tools/result`、`agent/error`、`agent/turn-stopping`；在 `amb-prompt.mjs` 按 `SugentSIMStore` 隔离状态过滤失效 `SKILL.md` / 插件。 | 严禁修改 `dsh-runtime/node_modules/@deepseek-ai/` 编译产物或覆写用户全局 `~/.gemini/config/hooks.json`。 |
| **宿主薄接线（`src/` 最小胶水）** | `src/app.ts` 统一 `<dataDir>/sugent-kg`（消除与 `src/agent/manager.ts` `<dataDir>/knowledge-graph` 的分裂）、把 `this.ruleEvents` 接上 `createEnvelopedRuleEventSink` 与 `TriggerCoalescer`、挂载周期扫描定时器；`src/agent/manager.ts` 复用统一图谱。 | 严禁大面积重写上游 `src/channels/`、`src/tasks/service.ts` 主调度或 `packages/dsh-superagent/` 任何源码。 |

---

## 4. 分阶段里程碑（M-Auto 1 – M-Auto 4）与验证门禁

### 4.1 演进里程碑

| 阶段 | 核心目标 | 交付物与代码落位 | 验收标准（Definition of Done） |
| :--- | :--- | :--- | :--- |
| **M-Auto 1**<br>基线合龙、显著性与追问门控 | 修复双图谱分裂，拦截无效 `diff_detected` 噪音，落地先查后问与心流边界投递 | `src/sugent/salience-gate.ts`、`src/sugent/clarification-gate.ts`、`proactive-cadence.ts`（心流队列/小时偏航/卡壳拆步）、`universal-dropzone.ts`；`src/app.ts` & `src/agent/manager.ts` 图谱合龙；`knowledge-graph.ts` 补齐 `ops.remove` | 1. 纯函数静态检查（零 FS/网络/时钟/厂商硬编码）全绿，0 Token `fast_template_digest` 拦截生效；<br>2. 默认废除 2 次/日硬上限，异构深潜进 `boundaryQueue`，重名/缺槽位触发带准备包的单点追问，`AgentManager` 与账本读写同一 `<dataDir>/sugent-kg`。 |
| **M-Auto 2**<br>执行仲裁与工具可靠性账本 | 收口并发任务冲突、预算超支、冰盒隔离与重试风暴 | `src/sugent/executive-arbiter.ts`、`test/sugent-executive-arbiter.unit.test.ts` | 1. `POLICY` 拦截（防社死/安全信封）不拉低 `ToolReliabilityRecord.emaScore`；<br>2. 低预算/免打扰/`icebox` 自动降档或延后，同目标 300s 审议超 3 次自动止损。 |
| **M-Auto 3**<br>SIM 账本与跨模型外科回滚 | 解决 BYOK 切模型失忆与全包回滚伤及无辜技能的问题 | `src/sugent/self-improvement-memory.ts`、`test/sugent-sim-and-gardener.unit.test.ts`；扩展 `causal-ledger.ts`、`self-evolution.ts` | 1. 切换 `gateway.ts` 角色模型后，`interface_invariant` 保留、`model_specific` 自动标 `needs_revalidation`；<br>2. 触发回归时仅隔离单个 `SKILL.md` / `sugent-ext-*` 并立碑，不动其它健康扩展。 |
| **M-Auto 4**<br>离线记忆园丁与伴行闭环 | 落地周度/异常巩固、目标偏航审计与软品味建模 | `src/sugent/memory-gardener.ts`、`steward-host-service.ts` 接线、`test/sugent-sim-and-gardener.unit.test.ts` | 1. 仅在周度校准或 Titans `surpriseMomentum >= 0.7` 时运行，遵守 `<0.2 / 0.2-0.5 / >=0.5` 三档 Token 封顶；<br>2. 候选规则/墓碑须过 `PROPOSED -> 3 次印证` 沙盒并入心流边界投递；<br>3. `LanguageProfiler` + `MergeGuard` 通过 `>= 2` 强证据合并门测。 |

### 4.2 验证门禁（Verification Plan）

每个里程碑合并前必须全部通过以下自动化门禁（遵循 [`AGENTS.md`](../../AGENTS.md) 第 2 节）：

1. 静态类型检查：`npm run typecheck`（`tsc -p tsconfig.json --noEmit`）零报错退出。
2. Sugent 全量单元与纯度测试：`npm run test:sugent` 覆盖既有 37 个测试文件及新增 `salience-gate`、`executive-arbiter`、`sim`、`memory-gardener` 契约测试，同时验证纯函数模块静态扫描零 `node:fs` / `fetch` / `Date.now` / `Math.random` / 厂商硬编码。
3. 编译构建与 18+ 项运行时契约自检：`npm run verify:sugent` 验证编译产物 `dist/src/sugent/`、打包 `extensions/` 插件隔离、BYOK 切模型后 SIM 状态流转及外科单点回滚。
4. 文档与上游零侵入检查：`npm run docs:check` 零错误零警告，且 `git diff --name-only` 确认 `packages/dsh-superagent/`、`src/channels/` 与 `src/tasks/service.ts` 保持零结构侵入，`npm run sync:upstreams` 可干净解析上游状态。
