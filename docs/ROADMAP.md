# Sugent 演进蓝图 (Product & Architecture Roadmap)

Sugent 按「外环生长 × 内环底座」两条主线并行演进：

1. **外环**是围着具体的人生长的私人幕僚，按「关系 · 目标 · 价值 · 事项 · 资源」五维生命账本沉淀长期默契。无论底层更换哪家模型或接入哪些外部兵团，用户在微信、飞书和桌面端面对的都是同一个了解前因后果的秘书，产品理念见 [`docs/PHILOSOPHY.md`](./PHILOSOPHY.md)。
2. **内环**是确定性自治内核与跨军团统帅底座，严守 `src/sugent/` 零侵入扩展边界（见 [`ARCHITECTURE.md`](../ARCHITECTURE.md) 与 [`AGENTS.md`](../AGENTS.md)）。它靠安全信封、挂起零消耗回执、跳数熔断与因果账本守住系统底线，把 `gateway.ts` 四角色模型路由、桌面 GUI 操控、外部 CLI 与重装工程兵团收在后台按需调遣，近期 4 周实施细节见 [`docs/plans/2026-11-20-jarvis-personal-os-and-antigravity-bridge.md`](./plans/2026-11-20-jarvis-personal-os-and-antigravity-bridge.md)。

在技术源头上，Sugent 融合了 [modelflare-ai/AnyModelBot](https://github.com/modelflare-ai/AnyModelBot)（多端消息触达与桌面操控）、[deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)（注意力经济学与 `Intake → Eval → Ticket` 状态机）以及 [KKKKhazix/agent-autoloop](https://github.com/KKKKhazix/agent-autoloop)（确定性安全隔离与因果溯源），并在个人主权之外支持通过 `business-level-cowork`（Port `28080`）接入团队协同。

### 三方分工：本机大管家、重装特种兵团与外部 `/ops` 看板

| 协同角色 | 职责定位 | 数据与权限边界 |
| :--- | :--- | :--- |
| **Sugent（本机主权大管家）** | 不开网页时在微信、飞书与桌面的随身幕僚，执掌五维总账、碎片收口与防社死拍板 | 个人档案与未脱敏草稿留在本机，支持 `mode: "none"` 免登录纯 BYOK 运行，不重复搬运看板页面 |
| **Antigravity App（重装工程兵团）** | 承接长链路软件工程、多 Agent Swarm 并行与深度课题攻坚 | 通过三表面只读数据库、独立插件目录钩子与 `agentapi` / MCP 与 Sugent 双向协同 |
| **外部 `/ops` 看板与公域投影端** | `/ops` 负责浏览器打开时的舰队全景战情视图，另含可选公域展示站与团队 Cowork（`:28080`） | 内核零硬编码任何私人站点或项目名，统一经 `PublicCanonPublisher` 与 `OpsProjectionSink` 输出，受动态隐私分级与 `tierEpoch` 约束 |

---

## 近期战役（第 1–4 周主航道）：N1–N4 从智能体工作台跃迁为贴身贾维斯幕僚

未来四周先把工作台收拢成围着具体的人生长的私人幕僚，并打通与 Antigravity App 的双向统帅通道。完整模块契约、数据结构与单测矩阵见 [`2026-11-20 实施规划`](./plans/2026-11-20-jarvis-personal-os-and-antigravity-bridge.md)。

### N1 唯一幕僚前台与全天候零负担投递口

用户面对的始终是同一个懂前因后果的秘书，不用建多个 Bot、手动切模型或手写 Cron 规则。微信、飞书和桌面主窗口收口为 One Jarvis 单一前台，个人生活与团队 Cowork 语境在底层存储和子图上物理隔离，[`src/sugent/gateway.ts`](../src/sugent/gateway.ts) 四角色路由、桌面 CUA 操控、外部 CLI 与 Antigravity 特种兵团全退到幕后按需调遣。

日常入口（`src/sugent/universal-dropzone.ts` 配合 [`electron/main.ts`](../electron/main.ts) 全局快捷键与托盘拖拽薄适配）先替掉微信「文件传输助手」和零散备忘录，收到任何文字、截图或文件后按四档接招：

1. `capture`（随手暂存）：只收不吵，存入本地档案并回一行极短回执。
2. `recall`（秒查家底）：1 秒检索个人数字档案库与知识图谱，直接亮出原文件、合同号或历史结论。
3. `advise`（利害参谋）：调出当前目标、价值红线和人脉背景，帮你权衡取舍。
4. `delegate`（交代跑腿）：在后台异步立项推进，只在完工交卷或遇到决策分叉时推送一张卡片。

碰到政务办理、线下沟通、跨平台预约这类没有现成 API 或 MCP 的琐事，秘书绝不回复「缺少工具」两手一摊。`HumanPrepBundle` 会先查清最新办理路径、从本地档案翻齐证件材料、整理出可直接照抄的操作卡或沟通小抄，并自动挂好后续跟进提醒，帮主人扛掉前 80% 的准备杂活。

### N2 五维生命账本与有分寸主动伴行引擎

`src/sugent/stewardship-ledger.ts` 复用 [`src/sugent/knowledge-graph.ts`](../src/sugent/knowledge-graph.ts) 的 `exclusive: true` 时效排他边机制，围绕具体的人维护五本活账：

- **关系**（`RelationshipProfile`）保存两件事：秘书与主人的四级信任阶梯（`L0 只记不评` → `L1 耳麦提词` → `L2 挂起待批` → `L3 观察转正`，即 `L3_shadow_autonomous`，支持随时一句话降级），以及重要家人、客户和合作方的往来脉络、禁忌雷区与未结人情。
- **目标**（`GoalNorthStar`）只收敛 1 到 3 条当前主航道与硬北极星判据，用来排事项优先级，并在主理人精力发散时温和拉回。
- **价值**（`ValueGuardrail`）区分硬红线和软品味。红线守住防社死外发禁令、资金风控、证伪墓碑防重犯以及动态隐私分级下的本地绝对主权底线，品味记住说话风格、厌恶套话、决策习惯和免打扰边界。
- **事项**（`CommitmentItem`）盯住还没收口的双向账：我欠别人的承诺（`I Owe`）、别人或外部智能体欠我的交付（`Waiting For`），以及快过期的证件、合约与会话（`Expirations`）。
- **资源**（`ResourceEntry`）统筹注意力时间窗、本地数字档案库（含证件和合同、保单与发票）和 API 预算账本，以及本机算力和外部智能体军团。

主动交互由 `src/sugent/proactive-cadence.ts` 驱动。纯函数核心扫描账本失衡与临期信号，并结合周期校准与跨端舰队脉冲生成候选，再经 `createAttentionBudgetGate` 每日配额门控（常规主动发起每日最多 `2` 次，无事彻底静默；紧急碰撞与节点异常直通并按 `dedupeKey` 去重）。免打扰期间或超配额而折叠进次日早间简报的候选，在真实外发前调用 `filterSupersededBeforeSend` 二次销账，若本机 IDE 已推进或外部已阅则自动静默剔除，余下候选再复用 [`src/sugent/receipt-protocol.ts`](../src/sugent/receipt-protocol.ts) 的 `SuspendedRoundStore` 与微信/飞书 `Outbox` 投递。

### N3 `Sugent ↔ Antigravity App` 双向统帅桥接器

`src/sugent/antigravity-bridge.ts`、`src/sugent/steward-mcp.ts` 与 `src/sugent/memory-gardener.ts` 把 Antigravity App 接入幕僚后方调遣体系，避免再造一台卡在公网的同步后台：

1. `AntigravityStateReader` 与 `FleetPulseReader`（三表面只读观测与跨端脉冲）：自动扫描 `~/.gemini/antigravity{,-cli,-ide}/conversation_summaries.db?mode=ro`（`app | cli | ide` 三表面），以 `(nodeId, surface, conversationId)` 唯一标识。归并时用 `canonicalizeProjectKey` 剥离 SSH Host 别名与 `.git` 后缀输出 `repo:<owner>/<repo>` 或 `local:<nodeId>:<slug>`（支持 `.ops-project.json` 声明），还原 `worktrees/<conv_id>/swarm-*` 并折叠 `nesting_depth > 0` 子代理到根会话。同时区分 `interactive`、`readonly-sidecar` 与 `subagent` 三类 `sessionRole`，定时只读巡检正常完工静默不进待审队列。冷启动水位取 `bootstrappedAt` 与近 `48h` 较近者，结合 `Auto-Supersede` 与 `ZeroTokenProbeTracker` 实现无增量 0 Token 退出，并用 `FleetPulseReader` 只读解析本地跨端镜像（如 `.ops_fleet_state.json`）感知多节点碰撞与待领 `Handoff`。
2. `AntigravityHookSink`（插件目录隔离与 `<1ms` 短路）：通过 `stageSugentStewardPluginHooks` 生成独立插件 `~/.gemini/config/plugins/sugent-steward/{plugin.json,hooks.json}`，绝不覆写用户全局 `~/.gemini/config/hooks.json` 软链。钩子首行识别 `/worktrees/`、`/subagents/` 与 `nestingDepth > 0` 在 `<1ms` 内短路返回；根会话的 `Stop` 通知剥离 stdio FD 异步投递并瞬间返回 `{"decision":"allow"}`，把 `cwd` 映射为 `workspacePath` 后送入 `sources.ts` 第 4 个内置源 `"antigravity"`。
3. `ArtifactComprehensionPipeline`（隔离消化与手机拍板）：读取 `brain/<conversation_id>/` 下的 `implementation_plan.md`、`task.md`、`walkthrough.md` 及带 `userFacing: true` 的 `*.metadata.json` 时，先经 [`src/sugent/security-envelope.ts`](../src/sugent/security-envelope.ts) 物理隔离防注入，再交给 [`src/sugent/gateway.ts`](../src/sugent/gateway.ts) 的 `steward` 角色结合五维目标与证伪墓碑消化成高信噪比微信/飞书拍板卡。
4. `AntigravityDispatcher`（真实 CLI 双向派单）：通过 `execFile` 参数数组调用官方 `~/.gemini/antigravity/bin/agentapi` 的三个实测子命令：`get-conversation-metadata` 核对元数据、`send-message` 唤醒原 `conversation_id` 续跑、`new-conversation` 在受控 `sidecar.json` 权限内开启新战役。
5. `sugent-steward-mcp` 与周度记忆园丁（`src/sugent/memory-gardener.ts`）：Sprint 3 的 MCP 配置收口进同一独立插件目录 `~/.gemini/config/plugins/sugent-steward/`（Stdio / Streamable HTTP `/mcp`），供 Antigravity 兵团按权限读取主人目标与红线。针对 `knowledge/<ki>/` 长期停更的问题，周度记忆园丁每周汇总已验收 `walkthrough.md` 与主人驳回批注，推一张提案卡经一键确认写回仓内 `.agents/rules/`、`TOMBSTONES.md` 与跨项目索引。

### N4 动态用户主权隐私分级、`tierEpoch` 防复燃与 `/ops` 互补边界

`ProjectPrivacyRegistry` 结合中英文敏感词根（`wallet`/`secret`/`credential` 及简历、财务、合同与薪资等词根，含未注册外置盘）和治理锚点（`ROADMAP.md`、`TASKS.md`、`TOMBSTONES.md`、`.agents`、`PROJECT.md`）启发式初判项目归属，并允许主人随时调用 `setProjectTier` 自由切档（`user_override`），绝不锁死任何仓库：

- `Tier 0`（静默脉搏，`local_only`）：仅在本机保留状态索引或静默脉搏，MCP 与外部投影接口不读正文。
- `Tier 1`（摘要雷达，`metadata_only`）：只放行脱敏 `projectKey`、状态枚举、里程碑计数与更新时间，剥离正文、绝对路径与人员姓名。
- `Tier 2`（深度治理，`summary_allowed`）：允许输出经清洗后的简短摘要或配合治理规则协同，向公域站点发布前仍须在本机渲染 Diff 并校验主人确认哈希。

每次切换级别都会单调递增 `tierEpoch`，降级或收到过期纪元载荷时由 `sanitizeForProjectTier` 拒绝或清空高阶正文，防止历史队列复燃。同时守住本地绝对主权底线：`personal_life` 分区、证件号、密钥和人脉雷区始终不出本机。分工上，外部 `/ops` 看板负责浏览器打开时的舰队全景战情视图，Sugent 负责不开网页时在微信与飞书的随身伴行与五维总账，两边经 `PublicCanonPublisher` 与 `OpsProjectionSink` 互补协作，不重复搬运看板页面，整套流水线在 `mode: "none"` 离线纯 BYOK 下依然完整可用。

### N1–N4 验收标准与 4 周 Sprint 映射

| 编号 | 核心交付物与模块 | 验收标准（Definition of Done） |
| :--- | :--- | :--- |
| **N1** | `src/sugent/universal-dropzone.ts`<br>[`electron/main.ts`](../electron/main.ts) 薄适配 | 1. 微信、飞书与桌面收口为单一私人幕僚前台，无多 Bot/手动切模型/手写 Cron 配置门槛，个人与 Cowork 语境物理隔离。<br>2. 四档分流（`capture`/`recall`/`advise`/`delegate`）跑通单测，无工具现实琐事产出完整 `HumanPrepBundle` 操作卡与跟进提醒。 |
| **N2** | `src/sugent/stewardship-ledger.ts`<br>`src/sugent/proactive-cadence.ts` | 1. 五维账本兼容 [`src/sugent/knowledge-graph.ts`](../src/sugent/knowledge-graph.ts) `exclusive: true` 排他演化，关系支持 `L0`–`L3` 升降级，主目标并发 `<= 3`。<br>2. 失衡与脉冲扫描通过静态纯度门禁，`createAttentionBudgetGate` 限制常规主动发起每日 ≤ 2 次，免打扰折叠进早间简报的候选在发送前过 `filterSupersededBeforeSend` 二次销账。 |
| **N3** | `src/sugent/antigravity-bridge.ts`<br>`src/sugent/steward-mcp.ts`<br>`src/sugent/memory-gardener.ts` | 1. `AntigravityStateReader` 扫三表面（`app \| cli \| ide`）`?mode=ro` 库并以 `(nodeId, surface, conversationId)` 标识，`canonicalizeProjectKey` 剥离 SSH 别名，区分三类 `sessionRole`，近 `48h` 与 `bootstrappedAt` 截断，并由 `FleetPulseReader` 只读消费 `.ops_fleet_state.json`。<br>2. `plugins/sugent-steward/{plugin.json,hooks.json}` 独立目录挂载（绝不覆盖全局 `hooks.json` 软链）、`<1ms` 子代理短路、MCP 同目录收口、`agentapi` 三子命令与周度记忆园丁全绿。 |
| **N4** | `ProjectPrivacyRegistry`<br>`PublicCanonPublisher`<br>`OpsProjectionSink` | 1. 结合中英文敏感词根与治理锚点初判 `Tier 0（静默脉搏）\| Tier 1（摘要雷达）\| Tier 2（深度治理）`，支持 `user_override` 自由切换与 `tierEpoch` 降级防复燃，守住本地绝对主权底线。<br>2. 明确 `/ops` 负责浏览器战情视图、Sugent 负责随身伴行与五维总账，外发前本机 Diff 盖印，`mode: "none"` 离线 BYOK 100% 可用。 |

| Sprint 排期 | 主攻战役 | 核心交付内容与门禁验证 |
| :--- | :--- | :--- |
| **Sprint 1（第 1 周）** | N2 账本底座 + N1 分流核心 | 落地 `stewardship-ledger.ts` 与 `universal-dropzone.ts`，在 `types.ts` 扩展 `"antigravity"` 源，通过 `L0`–`L3`、公私分区隔离及 `HumanPrepBundle` 单测 |
| **Sprint 2（第 2 周）** | N2 主动伴行 + N3 三表面观测、动态隐私与插件钩子 | 落地 `proactive-cadence.ts`（`48h` 截断与 `filterSupersededBeforeSend`）、`antigravity-bridge.ts`（三表面扫库、`.ops_fleet_state.json`、SSH 别名归一、三类 `sessionRole`、动态隐私 + `tierEpoch`、`plugins/sugent-steward/` 隔离与 `<1ms` 短路）及 `sources.ts` 第 4 内置源 |
| **Sprint 3（第 3 周）** | N3 隔离拍板/派单 + N4 投影契约与 MCP 插件收口 | 落地 `ArtifactComprehensionPipeline`、`AntigravityDispatcher`、`steward-mcp.ts`（MCP 配置收口进 `plugins/sugent-steward/`）、`PublicCanonPublisher` / `OpsProjectionSink`，通过 8 跳熔断与零硬编码检查 |
| **Sprint 4（第 4 周）** | 周度记忆园丁 + 桌面薄适配 + 全量收口 | 落地 `memory-gardener.ts` 与 `electron/main.ts` 热键/托盘薄适配，更新 `index.ts`、`verify-sugent.mjs` 与 `package.json`，全量跑通 `npm run typecheck`、`npm run test:sugent`、`npm run verify:sugent` |

---

## 对标沉淀：Sugent 现有底座 vs. Agent-Autoloop 借鉴矩阵

| 架构维度 | Sugent 现有基座（已落地） | 借鉴自 [Agent-Autoloop](https://github.com/KKKKhazix/agent-autoloop) 的增量演进点 | 计划落位模块（零侵入） |
| :--- | :--- | :--- | :--- |
| **安全与防注入边界** | 白名单发送者门控（`unlisted_sender` 零 Token 拦截）+ 三档目录权限围栏 | **类 SQL 参数化的指令数据物理分离**（参考 [Agent-Autoloop 安全边界](https://github.com/KKKKhazix/agent-autoloop/blob/main/SECURITY.md)）：外部不可信文本落盘为只读资料文件，提示词仅传校验后的 `source/type/id/url`，拒收带 `cwd`/`agent`/`access` 的越权事件载荷 | [`src/sugent/security-envelope.ts`](../src/sugent/security-envelope.ts)（✅ 已落地） |
| **防死循环与成本止损** | 单任务/单规则月度美元预算硬上限（`cost.ts`）+ 单次运行时间上限 | **TTL 级联跳数熔断（Hop Circuit Breaker）**：跨规则/跨 Bot 唤醒链路携带不可篡改的 `hopCount`（经人工提问或延迟复查不清零，默认超过 8 跳自动熔断停派并发卡告警） | [`src/sugent/kernel.ts`](../src/sugent/kernel.ts)、[`src/sugent/types.ts`](../src/sugent/types.ts)（✅ 已落地） |
| **可观测性与内核防腐** | SQLite 任务/运行表 + Markdown 运行记录导出（`export.ts`） | **Append-Only 因果溯源（`sugent why <id>`）与内核纯度门禁**：一条命令反查「触发源 → 规则版本 → 门控决策 → 执行模型 → 结果」，测试强制内核零外部请求、零供应商硬编码及随机种子状态机模拟验证 | [`src/sugent/causal-ledger.ts`](../src/sugent/causal-ledger.ts)（✅ 已落地） |
| **长流程挂起与自动续接** | `needs_you` 非阻塞提问 + 持久化 `Outbox` 队列 | **真「挂起零消耗」与回执动作扩展（`later` / `resolve` / `events`）**：等待拍板期间彻底释放空闲执行子进程，回复后按会话无缝续接，支持预约延迟复查、故障恢复自动更新原卡片及回执 JSON 局部重试 | [`src/sugent/receipt-protocol.ts`](../src/sugent/receipt-protocol.ts)（✅ 已落地） |
| **高频巡检降噪降本** | `assessor` 小模型守门分流 + `observe` 满 3 次提议转正 | **零 Token 前置脚本探针 + 同 `threadKey` 排队合并（Coalescing）**：无变化/健康正常时在探针层直接退出（0 Token），同一对象排队期多条事件合并为一轮执行，防并发踩踏 | [`src/sugent/sources.ts`](../src/sugent/sources.ts)（✅ 已落地） |
| **执行器与协同生态** | 内置 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) + [yetone/magpie](https://github.com/yetone/magpie) 四角色模型路由 | **免改接入异构外部 CLI Agent**：通过参数数组（防 shell 注入）与 ACP 协议一行配置调度本机 Claude Code、Codex、Cursor CLI、Hermes 等协同作业 | `src/sugent/external-agents.ts` |
| **代码审查与自动上线** | 双上游同步脚本（`scripts/sync-upstreams.mjs`）+ 双模热演进（`self-evolution.ts`） | **主干受信的标签驱动交付流水线（`deliver` / `deliver-review`）**（参考 [Agent-Autoloop 安全边界](https://github.com/KKKKhazix/agent-autoloop/blob/main/SECURITY.md)）：审查与发布规矩仅读 `main`，绝不在宿主机检出或运行外部 PR 代码，上线后核验 HTTPS 健康版本 | [`skills/sugent-delivery/SKILL.md`](../skills/sugent-delivery/SKILL.md)、[`src/sugent/delivery.ts`](../src/sugent/delivery.ts)（✅ 已落地） |
| **团队本体与企业治理** | 本地个人图谱（`SugentKnowledgeGraph`）+ 单人越界审批卡片 | **与 `business-level-cowork` 端-边动态联邦**：热挂载远程 FastMCP SSE 本体武器包、接入员工级 `sk-emp-*` 网关审计，打通 Staging 暂存门控与专家微信/飞书移动 HITL 审批 | [`src/sugent/cowork-bridge.ts`](../src/sugent/cowork-bridge.ts)（✅ 已落地） |

---

## 阶段一（已完成 ✅）：算力解耦、内核加固与安全自举

阶段一已完成算力自由与双层记忆底座搭建，吸收 [Agent-Autoloop](https://github.com/KKKKhazix/agent-autoloop) 的安全边界与引导体验，让 Sugent 安全接管自身仓库的日常维护。

| 状态 | 里程碑 | 关键交付物与模块 | 验收标准（Definition of Done） |
| :---: | :--- | :--- | :--- |
| ✅ | **M1.1 仓库基座与算力网关四角色解耦** | [`src/sugent/gateway.ts`](../src/sugent/gateway.ts)、[`scripts/sync-upstreams.mjs`](../scripts/sync-upstreams.mjs) | 1. 完成 `AnyModelBot` 宿主与 `dsh-superagent` 子树零侵入融合。<br>2. 支持 `SUGENT_GATEWAY_URL` 与 `SUGENT_UNLOCK_SUBSCRIPTIONS=1` 免登录直连自有网关或本机包月订阅，落地 `assessor` / `executor` / `computer_use` / `steward` 四角色路由。 |
| ✅ | **M1.2 双层混合记忆与自主知识图谱** | [`src/sugent/knowledge-graph.ts`](../src/sugent/knowledge-graph.ts)、[`src/agent/manager.ts`](../src/agent/manager.ts) | 1. 对话归档自动沉淀实体与 `exclusive: true` 时效排他边。<br>2. 支持 2 跳关联子图召回。<br>3. 累计验证 ≥ 3 次的 `workflow` 自动结晶生成标准 `SKILL.md`。 |
| ✅ | **M1.3 双模自我迭代与打包态热演进工作区** | [`src/sugent/self-evolution.ts`](../src/sugent/self-evolution.ts) | 1. 源码态直连 Git 工作流并通过 `npm run verify:sugent` 门禁保护。<br>2. 打包态（`app.asar`）隔离可写扩展目录（`plugins/` + `skills/`），支持 `resetSelfEvolutionOverlay()` 一键回退黄金镜像。 |
| ✅ | **M1.4 指令数据物理分离与防注入安全信封** | [`src/sugent/security-envelope.ts`](../src/sugent/security-envelope.ts)、[`src/sugent/sources.ts`](../src/sugent/sources.ts) | 1. 借鉴 [Agent-Autoloop 安全边界](https://github.com/KKKKhazix/agent-autoloop/blob/main/SECURITY.md)，外部事件标题与正文一律写入任务只读参考文件（`.context/event-<id>.md`），严禁裸拼进指令提示词。<br>2. 入口校验严格拒绝或剥离外部事件中的 `cwd`、`agent`、`permission` 字段，所有权限与执行目录仅由本机规则决定。 |
| ✅ | **M1.5 安全自举维护官与 PR 自动交付插件** | [`src/sugent/delivery.ts`](../src/sugent/delivery.ts)、[`skills/sugent-delivery/SKILL.md`](../skills/sugent-delivery/SKILL.md) | 1. 每日定时检查双上游更新并在隔离工作树跑通 `npm run verify:sugent`。<br>2. 支持 GitHub `deliver-review`（只审不合）与 `deliver`（审代码 → 等 CI → 合并 → 核验版本）标签流，审查配置只读 `main`，绝不在本机检出执行外来 PR 代码。 |
| ✅ | **M1.6 Agent-First 自引导安装与试跑（`sugent try`）** | [`INSTALL.md`](../INSTALL.md)、[`src/cli/try.ts`](../src/cli/try.ts)、[`src/cli/why.ts`](../src/cli/why.ts) | 1. 提供专为 Coding Agent 编写的 `INSTALL.md`，支持丢给任意 CLI Agent 自动完成环境配置。<br>2. `npm run sugent:try` 跑通「发事件 → 挂起退出零消耗等拍板 → 回复续接完成 → 引导生成首条个人规则」全链路体验，配套 `npm run sugent:why` 反查因果链。 |

---

## 阶段二：中期蓝图（第 1–3 个月）与核心底座深化

中期路线聚焦确定性事件中台、异构 CLI 协同，以及面向团队场景的 `business-level-cowork` 端-边动态联邦。

### 1. 内核可靠性加固：挂起零消耗、跳数熔断与因果溯源
借鉴 [Agent-Autoloop](https://github.com/KKKKhazix/agent-autoloop) 的确定性机制，围绕四项基础设施加固内核：
- [`src/sugent/receipt-protocol.ts`](../src/sugent/receipt-protocol.ts) 实现真「挂起零消耗」与结构化回执：等待人类审批或回答期间将上下文落盘归档并释放执行进程，拍板后按原会话 ID 自动续接。回执支持 `later`（预约 N 分钟后自唤醒复查）、`resolve`（故障恢复后自动更新或关闭原告警卡片）与 `events`（派生下游事件），JSON 格式有误时只重写最后一段。
- [`src/sugent/kernel.ts`](../src/sugent/kernel.ts) 落地 TTL 级联跳数熔断：跨规则/跨任务的级联唤醒链路携带不可由模型篡改的 `hopCount`（默认上限 `MAX_HOPS = 8`，跨越人工提问与 `later` 定时复查持续累加），超限立即停止派活并向「需要你」推送止损卡片。
- [`src/sugent/causal-ledger.ts`](../src/sugent/causal-ledger.ts) 落地单事务 Append-Only 事实日志与 `sugent why <id>` 溯源命令：一键查清任意任务的触发事件、规则版本与门控结论，以及领取的执行器和成本。
- `verify:sugent` 固化内核防腐检查（禁止 `src/sugent/kernel.ts` 引入外部网络请求或写死特定产品与模型名）及随机种子断网/崩溃/重复投递模拟测试。

### 2. 全景事件总线：零 Token 前置探针与同源防抖合并（[`src/sugent/sources.ts`](../src/sugent/sources.ts)）
- 两级降噪漏斗（Zero-Token Pre-Check Probes）在定时巡检与轮询源前挂载轻量脚本/HTTP 探针：网页正常或接口无增量 diff 时直接以退出码 `0` 退出，不唤醒 `assessor` 小模型也不花 Token，仅在首次异常或检测到新数据时才生成 `PersonalTrigger`。
- 同 `threadKey` 排队期防抖合并（Event Coalescing）把同一 Issue、PR 或告警线程排队期间连续涌入的事件合并成单轮输入，防止多个并发实例互相覆盖修改。
- 个人数据源持续扩展邮件与日历源（`mail_calendar`）、本地文件夹监听源（`filesystem`，如 `~/Downloads` 发票合同自动归档入图谱）以及多仓库 GitHub Webhook/轮询源（`github`）。

### 3. 异构 CLI Agent 免改接入与「影子转正」可视化
- 外部命令行协议适配器（`src/sugent/external-agents.ts`）在内置 DeepSeek Harness 之外，支持用独立参数数组（`command` 模式）或 ACP 协议接入本机 Claude Code、Codex、Cursor CLI 以及 Hermes、OpenClaw 等工具，复用各自已登录账号，完成「A 模型写代码 + B 模型独立审代码」交叉把关并独立核算用量。
- 影子演练账本（Shadow Ledger）与知识图谱面板在本地控制台展示 `observe` 模式下智能体「本打算做什么（`would`）」，满 3 次无误后一键升级为 `act`，同时提供实体关系图谱视图与 Git/WebDAV/S3 多端加密同步。

### 4. `Sugent × Business-Level Cowork` 端-边动态联邦桥接器（[`src/sugent/cowork-bridge.ts`](../src/sugent/cowork-bridge.ts)）
面向 3–50 人小微团队与企业现场工程师（FDE），在不合并双端代码仓库的前提下保持「插上即协同、拔下归个人」：
- 团队工作区「工作帽」热插拔（MCP SSE + 网关联合路由）：当工作区绑定团队 Cowork 端点（如 `http://<cowork-host>:28080`）与员工 API Key（`sk-emp-<user_id>-*`）时，复用 [`src/agent/host.ts`](../src/agent/host.ts) 的 `@deepseek-ai/dsh-mcp-client` 动态注入远程 `/sse` 的 5 大本体工具（`get_ontology_schema`、`query_graph_context`、`propose_field_knowledge`、`list_available_skills`、`submit_draft_to_staging`），并将推理流量经 [`src/sugent/gateway.ts`](../src/sugent/gateway.ts) 路由至 Cowork `/v1` 网关记账与审计（`/api/audit/logs`）。个人语境、私人 `MEMORY.md` 与本地隐私图谱保持离线隔离，永不上传团队服务端。
- 两级知识图谱联邦读写与 Staging 晋升防线：团队任务执行前先拉取 Cowork 已发布的版本化领域武器包本体与因果子图，严禁脱离证据臆测；一线成员（`technician`）在端侧验证成熟的经验不直接改写团队主图谱，而是经 `propose_field_knowledge` / `submit_draft_to_staging` 提交至 Cowork Staging 缓冲池（`PENDING_REVIEW`），通过 Pydantic 本体校验与事实性打分后等待领域专家审核。
- 企业 RBAC 挂起与微信/飞书移动「批奏折」：新增 `cowork_hitl` 事件源适配器（经 [`src/sugent/security-envelope.ts`](../src/sugent/security-envelope.ts) 物理隔离外部草稿正文防注入），当 Cowork 产生 `PENDING_REVIEW` 草稿或工作流因 `EffectLevel.EXTERNAL_COMMIT` 进入 `WAITING_APPROVAL` 时，自动向 `expert` / `APPROVER` 成员微信或飞书推送结构化审批卡片，手机拍板即可回调 `/api/hitl/approve`、`/api/hitl/reject` 或 `approve_and_resume`。

---

## 阶段三：商业化基座与生态蓝图（第 2–6 个月）

坚持「算力彻底开放（BYOK 自配 API 永久支持）+ 商业价值锚定身份协同与领域资产」战略（灰盒逆向适配器仅保留为极客实验选项，不纳入商业发行主路径），面向 OPC 创业者与小微团队分五块落地：

1. **多渠道统一身份聚合网关（`Sugent Auth Broker`）与商业权益体系（P0，见 [`实施规划`](./plans/2026-11-12-p0-sugent-auth-broker.md)）**
   - 架构解耦：桌面端保持单一标准 OIDC + PKCE 回环客户端（`SugentAuthManager`）零膨胀，云端构建轻量无状态 `Sugent Auth Broker` 统一对接微信扫码、Apple ID（Sign in with Apple）、Google 以及飞书和钉钉等身份源，集中托管各平台客户端密钥与固定备案回调域名。
   - 正交商业边界：账号体系仅承载会员订阅（Pro / Team License）、多设备端到端加密图谱与记忆同步（见 [`P2 BYOK 诊断与加密同步规划`](./plans/2026-11-12-p2-byok-diagnostics-and-e2ee-sync.md)）和移动审批通道绑定，不捆绑高溢价模型 Token 代充，且完全保留 `mode: "none"` 免登录单机 BYOK 主权模式。
2. **面向 OPC 创业者的「微信/飞书幕僚耳麦 + 明牌数字助理」防社死双轨交互（P1，见 [`实施规划`](./plans/2026-11-12-p1-opc-wechat-concierge.md)）**
   - 基于已落地的 [`src/sugent/security-envelope.ts`](../src/sugent/security-envelope.ts) 与 [`src/sugent/receipt-protocol.ts`](../src/sugent/receipt-protocol.ts) 跑通双轨通讯：对内充当主人的私密「幕僚耳麦」（静默旁听提炼待办、客户背景召回与话术草稿推送拍板），对外以「明牌数字助理」身份承接标准化预约、资料收集与工单回执，严守高风险外发动作 100% 经主人确认的防社死红线。
3. **从 Playbooks 升级为版本化领域武器包市场（Weapon Packages & Recipes）**
   融合 [Agent-Autoloop](https://github.com/KKKKhazix/agent-autoloop) 的高频实战配方与 `business-level-cowork` 的 `WeaponPackageManifest`（SemVer 版本控制 + 离线元模型校验 + 重放评测），提供个人与团队双模可导入资产包：
   - 团队「虚实中台」意见箱与工单分诊官：同事通过飞书或企微私聊提需求与现场故障，经 M1.4 安全信封隔离防注入后关联 Cowork 图谱评估或自动修改上线并回访，涉及 `EXTERNAL_COMMIT` 高风险动作推卡片找负责人拍板。
   - 端侧 CUA 数据采集 + Cowork 表格血缘分析流水线：发挥 Sugent 内置 [Cua Driver](https://github.com/trycua/cua) 原生桌面操控与本地目录监听能力，从老旧 ERP 或工业软件导出 CSV/XLSX 喂入 Cowork `TableIntakeEngine`、`DataLineageTracker` 与 `SolverCatalog`，生成 100% 证据可溯源的诊断与经营核算报告。
   - GEO（生成式引擎优化）跨 AI 浏览器巡检 / 周日代码库「反屎山」清道夫 / 5 分钟零消耗站点自愈监控：异常首次告警、持续异常静默、恢复后自动更新原卡片。
4. **Open-Core 签名发行版与移动端「批奏折」云中继**
   保持核心内核、BYOK 多模型注册表（[`src/sugent/provider-registry.ts`](../src/sugent/provider-registry.ts)）与插件体系开源透明。官方签名安装包（macOS 公证 DMG / Windows 签名安装包）预置指向 `Sugent Auth Broker` 的公共 `client_id`（客户端零密钥泄露风险），配套轻量云端加密推送中继实现外出手机秒级「批奏折」。
5. **小微团队与企业现场 Turnkey 联合交付套件（`1 × Cowork Hub + N × Sugent Edge`）**
   面向 3–50 人的工业运维 FDE 团队、OPC 联盟工作室、法务合规与外贸团队，提供 `1 台团队级 Cowork 本体治理容器 (:28080) + N 个成员端侧 Sugent 客户端` 一键部署镜像，原生具备钉钉和飞书组织架构映射、3 级 RBAC、群聊静默旁听（`followForContext`）、Staging 事实性门控与企业自配 API 预算审计能力。
