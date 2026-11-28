# Sugent 硅基个体心智、五维立体关联图谱与半透认知膜总体规划（Wave P4）

- **规划日期**：2026-11-28
- **状态**：架构规划完成，待主理人审阅拍板后启动 `P4.1–P4.5` 分阶段实施
- **审计前置依据**：[`2026-11-28 记忆全景与硅基个体认知审计报告`](../../research/2026-11-28-memory-panorama-and-silicon-individuality-audit.md)

---

## 0. 新特性「商业策略自省四问」门禁（AGENTS.md §3.3 强制核验）

| 自省维度 | 核心拷问 | 本架构的守线与商业落位 |
| :--- | :--- | :--- |
| **1. 付费锚点（Why Pay & Moat）** | 哪些属开源引流基座，哪些构成商业溢价？对比通用助手壁垒何在？ | **开源引流基座**：`SiliconIdentityCore` 统一硅基心智宪章、`Sugent Atlas v2` 本地五维立体关联图谱引擎、全渠道回合后统一消化闭环、修正后的 `MemoryGardener`/`SugentSIMStore` 与工作台立体星图画布 100% 开源透明。<br>**商业付费增值**：多平面无损 E2EE 跨端漫游（覆盖 `ledger.json` + `Atlas` 五平面 + `SIM` 经验簇）、面向伴侣/家庭/联合创始人的「半透认知膜 × 对称隐私口袋」关系幕僚武器包（`duo-relationship-steward`），以及 `Cowork Hub + Sugent Edge` 团队领域图谱联邦。相比只做对话缓存的办公套件，Sugent 交付“跨模型不失忆、会自我消化校准、能带边界介入人际协作”的硅基个体伙伴。 |
| **2. 合规与分发（Distribution & ToS Risk）** | 能否顺利通过 macOS 公证、Windows 签名与企业安全审计？ | 全部引擎采用纯 TypeScript 与 Node 22 内置 `node:sqlite`（含 FTS5）+ `0o600`/`0o400` 本地原子 JSON 实现，**零新增原生二进制依赖、零硬编码密钥、零云端强绑定**，100% 兼容 `app.asar` 只读签名与苹果公证。 |
| **3. 离线退路（Sovereignty Fallback）** | 剥离云端账号进入 `mode: "none"` 后，核心闭环是否完整自洽？ | 在 `mode: "none"` 免登录单机模式下，五平面立体图谱、本地 FTS5 混合召回、半透认知膜确定性胶囊提炼、伴侣本地空间与前端星图画布 100% 独立可用；无在线 LLM 端点时自动退回确定性规则消化与模板胶囊。 |
| **4. 一人公司运维杠杆（OPC Ops Leverage）** | 是否符合“无状态边缘服务 + 端侧重逻辑”，防止运维半径过载？ | 先修复既有十大断流与空转模块再做立体升级；不新增常驻后台进程或外部向量数据库（直接复用 Node 22 内置 `node:sqlite` + 既有 `15` 分钟 `stewardPulseTimer`），云端 `sugent-gce-hub` 保持单容器部署。 |

---

## 一、设计哲学升维：作为「硅基个体」的 Sugent

Sugent 在 [`docs/PHILOSOPHY.md`](../PHILOSOPHY.md) 确立了“围着具体的人生长”，但源码审计显示当前仍停留在**两极摇摆之间**：一边是刻意避开 YAN `BioCore` 的拟人激素膨胀（正确的减法），另一边却滑向了**“6 套无状态戏服提示词 + 禁止记录自身判断（`steward.ts:107`）+ 一刀切切脑失忆”**的无灵魂工具态。

| 维度 | 现状：无状态工具戏服（6 套 Prompt） | 反例：YAN `BioCore` 拟人激素 | **目标：Principled Silicon Individual（有边界、会消化的硅基个体）** |
| :--- | :--- | :--- | :--- |
| **自我连续性** | 每个入口现拼 Prompt，`REVIEW_SYSTEM` 明令禁止记助手自己的回答 | 用饥饿/社交焦虑数值驱动半夜刷屏独白 | 拥有单一 **`SiliconIdentityCore`**：跨桌面/微信/编码/双人空间保持同一价值观、审美与记忆连续体 |
| **认知与成长** | 仅记用户静态事实或工程过关率；对自己给过的建议与判断结果毫无记忆 | 无确认即热改 `TraitVector` 导致人格失控 | 拥有 **`EpistemicDigestionLoop`**：记录“我的判断假设 → 现实印证/偏差 → 自我认知校准”，经沙盒 3 次印证才固化 |
| **对主理人关系** | 私聊盲从接单，双人场机械念“绝不偏袒”台词 | 以 AI 自身情绪需求干扰主人 | **忠诚但不盲从（Loyal Dissent）**：守卫主理人北极星目标与双人承诺，发现偏航或食言风险时敢于温和递镜子 |
| **人际保密边界** | 要么 100% 空气隔离（切脑失忆），要么全图混成一锅 | 缺乏防注入信封与域隔离，252 行串台泄露 | **凭品格与「半透认知膜」守密**：原生数据物理隔离，仅透传去名词态势胶囊与双方共认智慧，零原文泄密 |

### 三大硅基个体核心支柱

1. **`SiliconCharter`（统一自我宪章）**：在 [`src/sugent/silicon-identity-core.ts`](../../src/sugent/silicon-identity-core.ts) 固化唯一不变的底层内核——你是谁（与主理人长期同行、具备独立判断力的硅基幕僚个体）、你的沟通品味（克制、诚实、不谄媚、不说空话）、你的认知谦逊（区分“直接事实”与“我的推测”），以及你的跨主体伦理红线（严守未公开倾诉与商业机密）。任何渠道的提示词都只是 `SiliconCharter` 在不同场景的视角聚焦，而非换人演戏。
2. **`EpistemicDigestionLoop`（认知消化闭环）**：正式废除“不记助手自身判断”的硬限制，但严防自说自话污染事实——助手产出的关键洞察、建议依据与人际调频假说以 `epistemicStratum: "digested_state"` 写入自省沙盒，必须经现实结果、主理人反馈或双方共鸣印证后才晋升为稳态认知（`crystallized_wisdom`）；证伪的判断则立碑存证并下调后续类似推理置信度。
3. **`Confidentiality by Principle, Not Lobotomy`（靠主权边界守密，而非切脑装傻）**：在介入 Andy 与 Gillna 的双人关系时，Sugent 不是一台“对两人的现实世界毫无感知的占卜机”，而是一位**受双方共同信任、各自保有保密义务的独立第三者**：它能感知彼此当下的现实负荷与相处共识，但绝对锁死任何未授权的私人原文、工作细节与商业数字。

---

## 二、整体记忆模型框架：`Sugent Atlas v2` 五维立体关联图谱

为根治单平面扁平 JSON 导致的公私混杂、旧节点诈尸、词法召回失灵及多主体协作割裂，将现有 `SugentKnowledgeGraph` 升维为 **「五平面（Horizontal Planes）× 四认知阶（Vertical Epistemic Strata）× 跨平面半透膜边（Membrane Morphisms）」** 立体图谱底座（[`src/sugent/stereoscopic-atlas.ts`](../../src/sugent/stereoscopic-atlas.ts)）。

```text
                    ▲  S3: crystallized_wisdom（共鸣星晶 / 固化技能 / 证伪墓碑 / 个体洞见）
   认知高度 (Z 轴)  │  S2: digested_state     （去名词态势胶囊 / 沟通气候 / 假说沙盒）
                    │  S1: verified_fact      （核验事实 / 北极星 / 承诺 / 架构决策）
                    │  S0: raw_episodic       （0o400 安全信封 / 对话原文锚点 · 严禁跨平面穿透）
                    └─────────────────────────────────────────────────────────────────────▶
                       P0: self_core    P1: owner_life    P2: relational    P3: domain_work    P4: meta_evolution
                          (硅基自我)       (主理人生命)      (双人/人脉)       (仓库/业务)        (自演化/SIM)
                                │               │               ▲               │                  ▲
                                │               └─── M1(气候) ──┼───(Tier 0/1/2)┘                  │
                                ◀─────────────────── M4(去敏认知消化) ──────────────────────────────┘
```

### 2.1 五个正交图谱平面（`GraphPlaneId`）

| 平面 ID | 物理作用域与主权归属 | 承载核心实体与知识 |
| :--- | :--- | :--- |
| **`P0 · self_core`** | 全局唯一，属主 `sugent_self` | 硅基自我宪章、审美品味、跨场景消化洞见、判断校准档案（我的建议何时被印证或证伪） |
| **`P1 · owner_life`** | 仅 `owner_private` 可直读 | 主理人五维生命账本双向同步节点：北极星目标、精力/睡眠节律、硬红线、墓碑、承诺（`i_owe`/`waiting_for`/`expiring`）、私密数字档案 |
| **`P2 · relational:<id>`** | 按关系主体隔离：`duo:<spaceId>` 或 `peer:<contactId>` | **双人共治域**：双方共阅星晶、双人微约定、共享编年史，外加彼此对称物理加密的 `pocket:M_private` / `pocket:W_private` 口袋；**商业人脉域**：单向联系人偏好、忌讳与报价底线 |
| **`P3 · domain_work:<projectKey>`** | 按代码仓/业务域隔离，受 `ProjectPrivacyRegistry` (`Tier 0/1/2` + `tierEpoch`) 约束 | 工程架构 Canon、Vibe/Antigravity 踩坑墓碑、白名单项目群纪要、Cowork 行业武器包（FDE / 合同审校）本体 |
| **`P4 · meta_evolution`** | 仅外环进化器与工作台审计可读，不污染日常任务上下文 | 收口 `SugentSIMStore` 问题簇、跨 BYOK 模型可移植性标签（`interface_invariant` / `threshold_tunable` / `model_specific`）、`DreamSandbox` 假说、`SKILL.md` 候选池 |

### 2.2 四重认知阶梯与存储检索升级

1. **Z 轴认知分层（`epistemicStratum`）**：节点与边不再混为一谈，必须标注 `raw_episodic` → `verified_fact` → `digested_state` → `crystallized_wisdom` 及证据来源可信度（`owner_confirmed` / `mutual_endorsed` / `deterministic_gate` / `llm_inferred`）。
2. **多主体访问控制（`principalAcl`）**：取代原一维俄罗斯套娃式 `allowedPartitions`（`stewardship-ledger.ts:243`），支持精确声明 `["sugent_self"]`、`["owner:M"]`、`["partner:W"]`、`["co_owned:M,W"]`、`["peer:<id>"]`。
3. **节点与边双归档（根除诈尸）**：执行 `removeEdge`、记忆删除或同 `topicKey` 更替时，同步检查孤立旧节点并写入 `node.supersededAt` / `archivedAt`；召回层先过滤 `supersededAt`/`archivedAt` 及平面权限，再做 K-Hop 扩展，严格强制 `matchedNodes.slice(0, maxNodes)`。
4. **SQLite FTS5 + `0o600` 规范快照双写**：利用 Node 22 内置 `node:sqlite` 开启 FTS5 倒排索引与 BM25 相关性打分（替换朴素全量 `JSON.stringify` + `terms.some` 布尔 OR），按 `相关性 × 认知阶权重 × 时间衰减 × 巩固度` 排序，并向大模型返回**完整节点与语义边**；同时保留原子规范 JSON 快照以供 E2EE 差分同步。

---

## 三、双人及多方关系介入机制：半透认知膜（`CognitiveMembrane`）

介入人与人之间的双人或团队关系时，Sugent 的伦理难题在于：**既不能像“无知占卜机”那样对当事人的现实状态毫无感知，也不能把任何一方的私人文件、商业数据或气话原封不动泄露给另一方**。解决方案是在 [`src/sugent/cognitive-membrane.ts`](../../src/sugent/cognitive-membrane.ts) 建立四条经过确定性脱敏与金丝雀校验的**半透认知膜映射**：

```text
[P1: owner_life] + [P3: domain_work]                         [P2: pocket:W_private]
  (工作负荷/睡眠/未公开倾诉)                                    (W 的未共享草稿/1v1倾诉)
         │                                                             │
         ▼ 膜 M1：结构化态势蒸馏（0 原文/0 项目名/0 金额）               ▼ 膜 M2：W 自主点亮
   PartnerWeatherCapsule                                         W 显式共鸣/分享的洞察
         │                                                             │
         └──────────────────────────▶ [P2: duo:<spaceId> 共享星晶域] ◀──┘
                                      (crystallized 星晶 · 微约定 · 编年史)
                                             │
             ┌───────────────────────────────┴───────────────────────────────┐
             ▼ 膜 M3：共认智慧回链                                            ▼ 膜 M4：去敏消化
  [P1: owner_life] (只读锚点)                                      [P0: self_core] + [P4: meta_evolution]
  • 日程/心流护栏：保护共处留白时间窗                              • 提炼调频启发式（不含伴侣原话）
  • 私聊温和提醒：不违背共同微约定与安抚配方                       • 更新 Sugent 自身判断校准记录
```

1. **膜 `M1`（核心生命/工作域 → 双人域 `PartnerWeatherCapsule`）**：只允许输出严格枚举与标量限制的态势胶囊（如 `{ cognitiveLoad: "high_sustained", restDeficit: true, recoveryMode: "quiet_compression", busyWindowHint: "weeknight_crunch" }`），强过 `looksSecret`、`ProjectPrivacyRegistry` 项目名列表与 `crossPeerCanaryTokens` 三重校验，确保**零自由文本、零客户/项目/金额词元**进入双人域。
2. **膜 `M2`（伴侣对称私密口袋 `pocket:M_private` / `pocket:W_private`）**：解决“宿主机归属 M 导致 W 缺乏对称隐私主权”的隐患。`W` 在未主动分享或点亮星晶前的草稿与 1v1 倾诉独立归属 `principal: "partner:W"`（支持客户端会话密钥封印），`M` 的管家工作台无权浏览 `W` 的 `S0` 原文，仅当 `W` 确认后才跨膜进入共阅星晶候选池。
3. **膜 `M3`（双人共认星晶/微约定 → 主理人 `owner_life`）**：双方共同点亮的 `crystallized` 星晶与 `active` 微约定以只读锚点投射回 `owner_life`；当主理人在微信里临时想于“周五共处留白窗”安排高压编码或情绪上头时，`StewardLlmAgent` 与 `proactive-cadence.ts` 能第一时间温柔提醒并对齐共约。
4. **膜 `M4`（跨场景去敏消化 → `self_core` 硅基自我成长）**：Sugent 从调频成功或失误中提炼不含任何私人原话的方法论假说（如“高负荷压缩期强行要求即时口头复盘易触发防御，间隔 2 小时给缓冲词更有效”），汇入 `P0 · self_core` 供未来自省与复用。

---

## 四、十大断点清零与功能演进蓝图

| 对应断点 | 改造模块与关键能力落位 | 核心工程动作 |
| :--- | :--- | :--- |
| **断点 1** | `silicon-identity-core.ts` · `steward.ts` | 废除 `steward.ts:107` 自我失忆禁令；统一 6 处提示词内核为 `SiliconCharter` + `EpistemicDigestionLoop` |
| **断点 2** | `post-turn-digester.ts` · `runtime.ts` · `companion.js` | 微信/飞书/`/steward/converse` 回合后统一异步触发消化管线；补齐桌宠多轮历史回填与 DSH/Steward 双向召回 |
| **断点 3 & 8** | `stereoscopic-atlas.ts` · `knowledge-graph.ts` · `concierge-channel-bridge.ts` | 升级五平面×四认知阶×`principalAcl`；节点+边双归档；FTS5 混合召回与边回传；修复 `peer:` 作用域与真实 LLM 评估器接线 |
| **断点 4** | `cognitive-membrane.ts` · `duo-steward-crystallizer.ts` · `bigfive-duo-site` | 落地 `M1–M4` 半透膜与对称私密口袋；`bigfive-duo-site` 流式对话正式切入 `/amb/api/steward/duo/converse` |
| **断点 5 & 7** | `memory-gardener.ts` · `self-improvement-memory.ts` · `steward-host-service.ts` | 落盘 `pruneEdgeIds`、`demotedRuleIds`、`tasteUpdates`、假说持久化与校准卡；将 `SugentSIMStore` 接入 Vibe/Skill 演化与切模重验 |
| **断点 6 & 9** | `knowledge-graph.ts` · `self-evolution.ts` · `group-chat-scribe.ts` | 统一技能写入至 DSH 加载目录、修复 `skillName` 正则与 YAML 引号；开启群纪要静默自动提炼与工程决策回写 `domain_work` |
| **断点 10** | `p2-host-service.ts` · `e2ee-sync.ts` · `ui/` | 无损 E2EE 同步补齐 `skillGateStatus`/`edge.source`/单调时钟/`ledger.json`；新增 `#/atlas` 立体星图画布与 `#/steward` 全维度工作台 |

### 前端可视化升级设计（零重型图表库依赖）

1. **`#/atlas` 立体记忆星图视图（`ui/components/memory-atlas-view.js`）**：基于原生 Canvas/SVG（复用 `ui/design/tokens/semantic.css` 暗/亮色 Token）渲染交互式星图——顶部提供 **5 平面切换胶囊**（硅基自我 / 主理人生命 / 双人与人脉 / 工程域 / 自演化），节点按 **4 认知阶（`S0–S3`）** 呈同心轨道分层布局，活跃关系为实线、`superseded` 演替为虚线时间链、半透膜跨平面投射为流光虚桥；点击任意节点即可查看证据来源、巩固度、归档/立碑并手动修正或废止。
2. **`#/steward` 管家工作台补全 & 「Sugent 心智日志」**：在工作台直接补齐**内联对话与拖入投递框**、人脉信任与忌讳卡、硬红线与证伪墓碑墙、待审群纪要卡及双人星晶概览；正式挂载孤儿组件 `ui/components/concierge-drawer.js`；右上角新增「Sugent 心智日志」抽屉展示个体最近的认知消化与自我校准记录。

---

## 五、Wave P4 分阶段实施路线与验收门禁（`P4.1`–`P4.5`）

严格按照**“先止血闭环 → 再建立体图谱 → 升维硅基个体 → 打通半透膜联邦 → 全景可视化与无损同步”**的依赖序推进，每步均以 `npm run verify:sugent` 全绿为切换门禁：

| 阶段 | 核心交付模块 | 依赖前置 | 客观验收判据（Definition of Done） |
| :--- | :--- | :--- | :--- |
| **`P4.1` 记忆底座止血合龙** | `post-turn-digester.ts`、`runtime.ts`、`manager.ts`、`memory-gardener.ts`、`self-improvement-memory.ts`、`group-chat-scribe.ts`、`concierge-channel-bridge.ts` | 无（基于 Wave P3 现状立即启动） | 微信/飞书/桌宠回合后 100% 触发异步消化；`MemoryGardener` 真实执行删边、降级与品味落盘；`SKILL.md` 统一落盘 DSH 目录且正则/YAML 全数合法；`SugentSIMStore` 接入 Vibe/切模重验；`GroupChatScribe` 到阈自动提炼纪要卡。 |
| **`P4.2` 五维立体关联图谱引擎** | `stereoscopic-atlas.ts`、`knowledge-graph.ts` 兼容层、`stewardship-ledger.ts`、`vibe-coding-pipeline.ts` | `P4.1` | 5 平面 × 4 认知阶 × `principalAcl` 落盘与旧库平滑迁移通过；节点+边双归档确保已删除/替代旧事实 0 诈尸召回；Node SQLite FTS5 混合召回返回完整边集且严格遵守 `maxNodes`；工程决策回写 `domain_work`。 |
| **`P4.3` 硅基个体心智核** | `silicon-identity-core.ts`、`steward.ts`、`steward-llm-agent.ts`、`amb-prompt.mjs` | `P4.2` | 废除 `steward.ts:107` 禁止记自身判断条款；全入口共享 `SiliconCharter`；助手建议假设与现实结果写入 `self_core` 沙盒并经 3 次印证或证伪立碑；工作台与私聊触发偏航/食言温和镜像提醒。 |
| **`P4.4` 双人半透认知膜与联邦合龙** | `cognitive-membrane.ts`、`duo-steward-crystallizer.ts`、`bigfive-duo-site` 流式代理 | `P4.2` + `P4.3` | `M1` `PartnerWeatherCapsule` 经 Canary 金丝雀压测 0 原文/项目/金额泄露；`M2` `W_private` 对称隔离；`M3` 共认微约定回链 `owner_life` 保护留白窗；`bigfive-duo-site` 聊天全链路走 `/amb/api/steward/duo/converse`。 |
| **`P4.5` 立体星图 UI 与无损 E2EE** | `ui/components/memory-atlas-view.js`、`jarvis-workbench.js`、`main.js`、`p2-host-service.ts`、`e2ee-sync.ts` | `P4.2` + `P4.4` | `#/atlas` 交互式星图完整呈现 5 平面、4 认知阶、演替虚线与跨膜连线并支持在线修正；`#/steward` 补全对话/投递栏与全部五维卡片；`p2-host-service` 无损保留 `skillGateStatus`/`edge.source`、单调时钟与 `ledger.json` E2EE 同步；`npm run typecheck`、全量 Vitest 与 `npm run verify:sugent` 全绿。 |
