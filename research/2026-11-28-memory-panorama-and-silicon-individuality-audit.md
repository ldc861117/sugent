# Sugent 记忆全景、全渠道应用触点与硅基个体认知审计报告

- **审计日期**：2026-11-28
- **审计基线**：`ldc861117/sugent`（`src/sugent/*`、`src/agent/*`、`src/core/runtime.ts`、`src/app.ts`、`src/web/server.ts`、`ui/*`）× `ldc861117/bigfive-duo-site`
- **审计方法**：全仓源码逐行核验（覆盖存储落盘、读写触发、图谱召回、跨端同步、双人关系与 UI 可视化）

---

## 一、全景盘点摘要

基于对 `<dataDir>` 底层持久化资产与 6 大运行时交互触点的交叉盘点，Sugent 当前并非缺少记忆模块，而是呈现**四大结构性偏差**：

1. **模块库丰裕但读写回路割裂**：虽然已建成 `MemoryStore`、`SugentKnowledgeGraph`、`StewardshipLedger`、`ChatTranscriptRecallService`、`GroupChatScribe`、`DuoStewardCrystallizer` 与 `SugentSIMStore`，但 Wave P0.1 将微信/飞书主理人私聊接入 `StewardLlmAgent` 后提前 `return`，绕过了 `AgentManager.scheduleReview()`；同时 `MemoryGardener` 算完修剪/降级结果直接丢弃，`SugentSIMStore` 在生产运行时 0 调用。
2. **单平面扁平图谱与「已废止节点诈尸」**：`SugentKnowledgeGraph` 将个人生活、工作项目、群聊、系统自检全部混压在单张扁平 JSON `Map` 中，缺乏「图谱平面 × 认知阶层」立体维度；`removeEdge` 只标边不归档节点，导致旧事实通过子串匹配永久被召回。
3. **戏服式无状态提示词与自我失忆禁令**：6 个入口各自拼接独立的无状态人设 Prompt，且 `src/agent/steward.ts:107` 明确禁止记录“助手自己的回答内容”，导致 Sugent 无法积累跨场景的连续自我认知、判断校准与独立边界。
4. **双人关系「一刀切失忆」与隐私不对称**：`DuoStewardCrystallizer` 与核心管家完全断连，使 Sugent 在双人对话中不知主理人现实高压负荷、在主理人私聊中不知双人共约留白；同时 `bigfive-duo-site` 流式对话直连 Gemini 绕开 `/duo/converse`，且伴侣 `W` 缺少对称的私密口袋。

---

## 二、存储底座全景矩阵（`<dataDir>` 全资产盘点）

| 落盘路径（`<dataDir>/...`） | 宿主类与源码位置 | 格式与核心结构 | 写入触发器 | 读取 / 召回通路 | 清理 / 淘汰现状 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`anymodel.db`** | `Store` (`src/store/db.ts:461-618`, `src/app.ts:250`) | SQLite WAL (`0o600`)：`conversations`、`messages`、`agent_segments`、`kv`、`rules`、`tasks`、`runs` | `BotRuntime` 入站/出站 (`runtime.ts:412-415, 718`)；`AgentManager.review` 游标；`TaskService` | `store.contextWindow`；`AgentManager.transcript`；`ChatTranscriptRecallService` | `tasks/runs` 30 天归档（`retention.ts:15`）；`messages` / `agent_segments` **无 TTL 永久增长** |
| **`memory/{bots,groups,team}/MEMORY.md` + `topics/*.md` + `journal.jsonl`** | `MemoryStore` (`src/agent/memory.ts:122-283`) | 扁平 `- <text> [source; added]` 列表 + `## Index`（`ENTRY_MAX=300`, `MEMORY_MAX=4000`） | DSH 工具 `remember`/`forget`；`AgentManager.review()` 90s 静默审校；InfoPanel 删除 | DSH 段首 `memoryPrefix` 冻结注入 (`runtime.ts:699`)；DSH `recall` 工具。**`StewardLlmAgent` 永不读取** | 超限抛 `MemoryError` 需人工或 `REVIEW_SYSTEM` `remove`；`journal.jsonl` 只增不减 |
| **`sugent-kg/knowledge-graph.json` + `kg-journal.jsonl` + `sync-meta.json`** | `SugentKnowledgeGraph` (`knowledge-graph.ts:154-623`) · `SugentP2HostService` (`p2-host-service.ts:92-129`) | `{ version: 1, nodes: KGNode[], edges: KGEdge[] }` 单一全局平面 JSON + 流水账 | `AgentManager.review` -> `ingestMemoryReviewOps`（深度抽取需 `SUGENT_KG_DEEP_EXTRACT=1`）；`StewardshipLedger.persist()` 单向影子写入；`p2Service.pullSync` | `StewardLlmAgent` 工具 `query_personal_memory`（**丢弃 `activeEdges`**）；`UniversalDropzone`；`ConciergeChannelBridge`。**DSH 永不读取** | `exclusive: true` 与 `removeEdge` 仅标 `edge.supersededAt`；**节点永不归档删除**；`MemoryGardener` 修剪建议未落盘 |
| **`sugent-stewardship/ledger.json` + `ledger-journal.jsonl`** | `StewardshipLedger` (`stewardship-ledger.ts:336-895`) | 五维活账：`relationships` / `goals` / `guardrails` / `commitments` / `resources`（三分区标签） | 管家工具、`POST /steward/*`、`StewardMcpServer`、`GroupChatScribe.approveDigest`、转发参谋入账 | `StewardLlmAgent.buildSystemPrompt`（活跃目标/<=8 承诺/<=6 护栏/<=5 人脉）；`scanLedgerImbalances`；离线摘要 | `MAX_ACTIVE_GOALS = 3` 限制活跃态；历史目标、已结承诺、墓碑、档案与流水账**零归档压缩** |
| **`sugent-stewardship/steward-web-turns.jsonl`** | `ChatTranscriptRecallService` (`chat-transcript-recall.ts:358-709`) | 只追加 JSONL `{ channel, peerId, role, content, createdAtMs }`（已脱敏） | `POST /steward/converse` (`server.ts:630-644`) 且 `domain === "owner_private"` | `hydrateRecentPeerHistory("web_ui")` 与 `recallChatHistory` 工具（合并 SQLite） | **无截断/归档**：每次调用均 `fs.readFileSync` 全量读入切分（`431-462`） |
| **`duo-spaces/<spaceId>/duo-vault.json` + `duo-kg/` + `seal-workspace/`** | `DuoStewardCrystallizer` (`duo-steward-crystallizer.ts:356-1298`) | 物理隔离双人库：`crystals`、`commitments`、`reports` + 独立 `SugentKnowledgeGraph` + `0o400` 信封 | `/amb/api/steward/duo/{crystallize,review,echo,converse,envoy-group}` | `getVaultSnapshot` 与 `converseAsDuoSteward`（注入 <=8 生效星晶 + <=6 微约定） | `reports` 保留最近 24 份；旧星晶、`duo-kg` 与 `seal-workspace` 持续累积 |
| **`dsh/<botId>/skills/` vs `skills/` vs `self-repo/extensions/skills/`** | `AgentManager.review` (`manager.ts:660`) vs `SugentStewardHostService` (`steward-host-service.ts:1721`) vs `self-evolution.ts` | 标准 `SKILL.md`（YAML frontmatter + SOP 步骤） | DSH 后台自动结晶写入 `dsh/<botId>/skills`；工作台审批写入 `<dataDir>/skills` | DSH 仅扫 `dsh/<botId>/skills` 与 `.dsh/skills`；**`<dataDir>/skills` 为零读者孤岛** | 每目录 `maxActiveSkills = 12` 淘汰低巩固度结晶技能 |
| **`self-evolution-sim.json`** | `SugentSIMStore` (`self-improvement-memory.ts:100-233`) | `SimProblemCluster[]`（尝试假设、预期-实测偏差、可移植性分级） | **生产运行时 0 写入调用**（仅在 `steward-host-service.ts:526` 实例化） | **生产运行时 0 读取调用**（仅在单测中被调用） | 无（读取时仅 `slice(-12)`） |
| **`sugent-stewardship/causal-ledger.jsonl`** | `CausalLedger` (`causal-ledger.ts:122-436`) | 同步 `fsyncSync` SHA-256 哈希链事实流 | `AntigravityDispatcher`、`VibeCodingPipelineOrchestrator`、`AdaptiveModelRouter` | `runGardener` (`listRounds()`)、`sugent:why` 命令行溯源 | **无轮转**：每次启动从 `seq=1` 全量重放校验哈希链（`226-260`） |
| **`sugent-routing/routing-experience.json`** | `RoutingExperienceStore` (`routing-experience-store.ts:222-576`) | 14 天半衰期贝叶斯质量/TTFT/花费统计 + 最近 60 条决策 | `AdaptiveModelRouter` 每次选模与隐式纠错反馈 | `AdaptiveModelRouter.planRoute` 与工作台排行榜 | 决策列表上限 60；统计单元读时衰减不删除 |
| **`sugent-stewardship/group-scribe-state.json`、`suspended-rounds/*.json`、`seal-workspace/`** | `GroupChatScribe`、`SuspendedRoundStore`、`ArtifactComprehensionPipeline` | 群消息环形缓冲（200 条/群）+ 纪要卡 + 挂起轮次 + `0o400` 只读信封 | 助理微信号群旁听、高风险挂起、外部文件/消息隔离 | `distillGroupDigest` / `approveDigest`、审批恢复 | `group-scribe` 满 200 条静默滑出；`suspended-rounds` 与 `seal-workspace` 永不清理 |
| **`sugent-offline-vault/processed-queue.json`** | `E2eeOfflineDigestVault` (`offline-digest-and-power-guard.ts:461-669`) | 已处理离线待办 ID 幂等集合（上限 10,000） | `drainOfflineTaskQueueOnWake`（**宿主运行时未接线调用**） | 构造器加载防重放 | FIFO 上限 10,000 |

---

## 三、全渠道应用触点读写矩阵

| 交互触点 | 运行时引擎 | 每轮自动召回注入 | 按需工具调用 | 回合后自动抽取 / 写回 |
| :--- | :--- | :--- | :--- | :--- |
| **(a) 桌面 Web 对话** (`#/chat/<bot>`) | `BotRuntime` → `AgentManager` → DSH (`amb-prompt.mjs` + `amb-memory.mjs`) | 仅在 DSH 会话**段首第 1 轮**冻结注入 `MEMORY.md`（`runtime.ts:699, 958-961`）；**无** `StewardshipLedger` 与 `SugentKnowledgeGraph` | `remember` / `forget` / `recall`（仅读写 `MemoryStore`）；读取 `dsh/<botId>/skills` | 写入 SQLite `messages`；90s 静默触发 `review()` 更新 `MEMORY.md`、调 `ingestMemoryReviewOps`（深度抽取需环境变量开启）、结晶技能；**永不写五维账本** |
| **(b) 桌宠与管家工作台** (`/steward/converse`, `/steward/dropzone`) | `SugentStewardHostService` → `StewardLlmAgent`（无在线端点退回 `UniversalDropzone`） | 注入活跃目标(<=3)、在途承诺(<=8)、护栏(<=6)、人脉忌讳(<=5)与态势计数（`steward-llm-agent.ts:585-660`）；**无 `MEMORY.md`、无自动子图**；`companion.js:195` 未传 `history` | `query_personal_memory`（仅回节点丢弃边）、`recall_chat_history`、账本/Vibe/Ops 工具（19 个） | 追加写入 `steward-web-turns.jsonl`（`steward-host-service.ts:942-943`）；**无回合后 `review()`**，仅靠模型主动调工具或 Dropzone 分类落账 |
| **(c) 主号微信 / 飞书私聊** (`OwnerChannelStewardRouter`) | `BotRuntime` 拦截 (`runtime.ts:401-418`) → `StewardLlmAgent` | 同 (b) `buildSystemPrompt` + 从 SQLite 回填最近 `<= 20` 轮对话（`owner-channel-steward-router.ts:115-128, 239`）；**无 `MEMORY.md`** | 同 (b) + `/done` `/snooze` `/gdig` `/pub` `/ops` `/send` `/undo` 指令 | 写入 SQLite 后于 `runtime.ts:418` **提前 `return`，100% 绕过 `scheduleReview()`**；仅当含 `[合并转发的聊天记录]` 时确定性写入账本（`231-237`） |
| **(d) 助理微信号边车 & 群纪要** (`wechat-envoy-sidecar.ts`, `group-chat-scribe.ts`) | `WeChatEnvoyPoller` → `ConciergeChannelBridge` / `GroupChatScribe` | `Concierge` 调 `recallPeerIsolatedSubgraph`（因无 `peer:` 标签**恒为空**）且使用纯正则评估器、忽略 `StewardshipLedger`；`GroupScribe` 无图谱/账本召回 | 无 | `Concierge` 写 `0o400` 隔离信封，零图谱/账本写回；`GroupScribe` 仅缓存在内存/JSON，**从不自动提炼**，需人工触发 `distill` + `/gdig ok` 才落账 |
| **(e) 公域网站访客** (`publicConciergeQueue`) | 远端 `/ops` 预生成草稿 → `OpsBridgeClient` 拉取 | 远端生成草稿时**零召回本机记忆**；本地仅在工作台提示词注入待审计数与前 3 位访客名（`steward-llm-agent.ts:636-639`） | `/pub`、`decide_public_visitor` 工具或 REST 接口 | 仅更新远端 `/ops` 决策与本地 `ops-notified-state.json` 去重；**零写回**五维账本或图谱 |
| **(f) Vibe Coding / Antigravity / 行业武器包** | `VibeCodingPipelineOrchestrator` + `AntigravityStateReader` + `StewardMcpServer` | `Vibe` 派单走 `TaskService.create` 注入 `MEMORY.md`，**无五维账本/图谱**；`Antigravity` 仅靠手动配 `StewardMcpServer` 按 Tier 1/2 拉取 | `StewardMcpServer`（5 个工具） | `Vibe` 与 `Antigravity` 产出的工程结论**不自动沉淀回图谱或账本**；武器包虽可写 KG/账本但无 HTTP 路由、LLM 工具与 UI 入口 |

> 注：主窗口 `#/steward`（`ui/components/jarvis-workbench.js`）目前既没有对话输入框，也没有万能投递口（Dropzone）；实时对话与拖入投递仅存在于独立的悬浮桌宠窗口（`ui/companion.js`）。

---

## 四、十大源码级核心断点清单

1. **断点 1 · 戏服式分裂提示词与自我失忆禁令**：`system.ts:20,80`、`steward-llm-agent.ts:601`、`steward-host-service.ts:948`、`concierge-assessor.ts:122`、`duo-steward-crystallizer.ts:336` 各拼一套无状态角色台词；更关键的是 `src/agent/steward.ts:107` 明确下令**“不要记一次性的任务细节、闲聊、助手自己的回答内容”**，导致 Sugent 彻底丢失自己过往作出的判断、建议理由与现实印证结果，无法形成连续硅基人格。
2. **断点 2 · P0.1 双脑合龙后的回合后记忆断流与跨脑互盲**：`BotRuntime.handleMessage`（`src/core/runtime.ts:401-418`）将微信/飞书主理人私聊拦截给 `StewardLlmAgent` 后在 `418` 行提前 `return`，100% 绕过了 `AgentManager.scheduleReview()`（`src/agent/manager.ts:540, 616`）；桌面悬浮窗 `ui/companion.js:195` 请求 `/steward/converse` 未传 `history` 且服务端未自动回填多轮上下文；DSH 侧只读写 `MEMORY.md`，`StewardLlmAgent` 侧只读写 `StewardshipLedger` 与 `KG`，两边互不相识。
3. **断点 3 · 单平面扁平图谱与已废止节点“诈尸”召回**：`SugentKnowledgeGraph`（`knowledge-graph.ts:48-73, 295, 387-464`）缺少图谱平面、认知阶层与主体 ACL；`removeEdge` 与 `ops.remove` 仅标 `edge.supersededAt` 却不归档节点，`recallSubgraph` 先按子串匹配全量 `this.nodes`，使已删除或过时的旧事实永久被召回；且当 `query === ""` 时绕过 `maxNodes = 20` 返回全表，同时 `steward-host-service.ts:722` 丢弃 `.activeEdges` 只给模型喂孤立节点。
4. **断点 4 · 双人关系“一刀切失忆”与伴侣隐私不对称**：`steward-host-service.ts:762-770, 1066-1132` 中核心管家对 `duoCrystallizer` 零感知、零工具，导致正向不知主理人连续熬夜救火的现实负荷、反向不知双人点亮的“周五晚不谈工作”微约定；`bigfive-duo-site/server/personalityChat.ts:592-753` 流式对话直连 Gemini 未走 `POST /amb/api/steward/duo/converse`；且 `duo-spaces/<spaceId>/seal-workspace/` 将双方 1v1 对话同置于主理人宿主机下，伴侣 `W` 缺乏对称私密口袋。
5. **断点 5 · `MemoryGardener` 空转丢弃计算结果**：`memory-gardener.ts:271` 硬编码 `kgPruningDelta: {}`；`steward-host-service.ts:1642, 1974` 固定传入 `hypotheses: []` 且未传 `ruleStats`/`recentMessagesByPeer`；算出的 `pruneEdgeIds`、`demotedRuleIds`、`tasteUpdates` 与 `calibrationCardLines`（`src/app.ts:760-796`）全部被丢弃，唯一副作用仅是更新 `pulse-state.json` 时间戳。
6. **断点 6 · 技能结晶四重目录错位与 DSH 解析拒载**：`AgentManager.review()` 写向 `dsh/<botId>/skills`，工作台批准接口 `decideSkillCandidate`（`steward-host-service.ts:1721`）却写向 `<dataDir>/skills`（DSH 不读且被 `AMB_DENY_READ` 封锁），打包态 `self-evolution.ts:306` 写向 `./skills` 而 DSH 仅扫 `.dsh/skills`；叠加 `knowledge-graph.ts:474-480` 生成含 `--`/尾随 `-`/`_` 的非法 `skillName` 及未加引号的 YAML `description`，导致 DSH 静默丢弃结晶技能。
7. **断点 7 · `SugentSIMStore` 与单件隔离 100% 悬空**：`self-improvement-memory.ts` 仅在 `steward-host-service.ts:526` 构造，`recordAttempt`、`flagOnModelSwitch`、`evaluateRegression` 与 `quarantineSelfEvolutionArtifact`（`self-evolution.ts:502`）在 `src/` 业务代码中均为 **0 调用**。
8. **断点 8 · 外部耳麦子图标签断层与全图金丝雀误杀**：`concierge-channel-bridge.ts:88-100, 272-301` 按 `peer:<id>` 前缀过滤子图，但 `StewardshipLedger` 写入 `rel:<id>` 且全仓无代码写入 `peer:` 前缀，导致联系人子图召回恒为空，反而将全量私人节点名变成 `crossPeerCanaryTokens` 引发常规中文词误拦截；且 `setModelPortOverride` 从未调用，只跑纯正则评估并忽略 `StewardshipLedger` 信任阶梯。
9. **断点 9 · 群纪要无自动提炼脉搏与工程/武器包记忆零回流**：`GroupChatScribe` 缓冲满 200 条静默滑出（`group-chat-scribe.ts:530-532`），`runScheduledPulse` 从不自动触发 `distillGroupDigest` 与推送；`VibeCoding`（仅注入 `MEMORY.md`）与 `AntigravityArtifactReader` 均不把架构决策回写进图谱；`weapon-packages.ts` 缺乏 HTTP 路由、LLM 工具与 UI 入口。
10. **断点 10 · E2EE 同步有损覆盖与前端可视化断层**：`p2-host-service.ts:136-210` 同步图谱时丢弃 `skillGateStatus`、把所有边 `source` 覆写为 `"e2ee_sync"`、用单设备 `lamportClock` 批量覆盖全部节点/边时钟，且漏同步 `ledger.json`；前端 `#/steward` 缺少对话/投递栏与人脉、护栏墓碑、群纪要、星图可视化画布，`ui/components/concierge-drawer.js` 从未被任何页面引入挂载。
