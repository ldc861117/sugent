# Sugent 演进蓝图 (Product & Architecture Roadmap v2.0)

> **定位锚点（2026-11 批判校准版）**：Sugent (`ldc861117/sugent`) 不与 T3 Code (`pingdotgg/t3code`)、Paseo (`getpaseo/paseo`)、Paradev (`ParadevAI/Paradev`) 在「L2 纯代码仓多 CLI 并发面板」红海同维内卷，而是守住正上方的 **「L3 个人主权幕僚 OS × 端-边治理总线」** 生态位——向上承接微信、飞书与桌面的全天候碎片意图，中间靠五维生命账本、显著性仲裁与防社死护栏消解“多 Agent 看护税”，向下按需调遣自适应模型网关、原生桌面 GUI（CUA `trycua/cua`）与 ACP (`agentclientprotocol/agent-client-protocol`) 编码特种兵团，向外通过 `1 × Cowork Hub (:28080) + N × Sugent Edge` 联邦切入小微团队与工业现场交付。完整竞品对标与自我批判审计见 [`research/2026-11-23-t3code-landscape-and-sugent-critical-review.md`](../research/2026-11-23-t3code-landscape-and-sugent-critical-review.md)。

---

## 0. 路线图迭代「商业策略自省四问」（AGENTS.md 强制门禁）

遵循 [`AGENTS.md`](../AGENTS.md) 第 3.3 节铁律，本轮路线图收敛与升级前逐项核验如下：

| 自省维度 | 核心拷问 | 本版路线图的收敛与守线决策 |
| :--- | :--- | :--- |
| **1. 付费锚点（Why Pay & Moat）** | 哪些属开源引流基座，哪些构成商业溢价？对比 T3 Code 与大厂办公套件优势在哪？ | **开源引流基座**：本地唯一幕僚内核、BYOK 自适应路由、五维生命账本、ACP 多 CLI 协同、隐藏 Git 快照与安全信封 100% 开源透明。**商业付费增值**：`Sugent Auth Broker` 驱动的外出手机 E2EE 离线摘要舱与秒级「批奏折」中继、跨设备加密记忆/SIM 漫游，以及 `Cowork Hub + Sugent Edge` 垂直行业武器包（工业 FDE 诊断、合同报价防漏）。相比 T3 Code 仅服务程序员盯终端，Sugent 交付跨模型不失忆的业务防错资产与非代码桌面/现实事务闭环。 |
| **2. 合规与分发（Distribution & ToS Risk）** | 能否顺利通过 macOS 公证、Windows 签名与企业审计？有无平台封号隐患？ | 严守只读签名外壳（[`hot-bundle-slots.ts`](../src/sugent/hot-bundle-slots.ts) 外置 Ed25519 签名热更槽不改 `app.asar` 一字节）；CUA 屏幕录制与辅助功能改为**首次触发按需懒授权**以消除安装恐慌；微信通道严守官方 `Tencent/openclaw-weixin` iLink 边界（主打转发/截图秒回小抄，不采用非官方私人聊天窗读取手段）；绝不默认预置跳过权限确认选项，灰盒适配器严格隔离在商业发行默认路径之外。 |
| **3. 离线退路（Sovereignty Fallback）** | 剥离云端账号进入 `mode: "none"` 后，核心闭环是否依然完整自洽？ | 在 `mode: "none"` 免登录离线主权模式下，本地 BYOK / Ollama 对话、CLIProxyAPI 模型池缓存、五维账本、安全信封、Worktree 隐藏快照、客观门禁验证与 L0–L3 热重载 100% 单机闭环运行，零遥测、零云端强依赖。 |
| **4. 一人公司运维杠杆（OPC Ops Leverage）** | 是否符合“无状态边缘服务 + 端侧重逻辑”，防止单人维护半径过载？ | **先做减法再推进**：冻结横向新概念扩张，优先合龙既有 61 个模块与 [`src/app.ts`](../src/app.ts) 主循环，隐藏上游遗留多 Bot / Modelflare 冗余包袱，通过标准 ACP 协议复用外部成熟编码 CLI，云端仅保留极薄无状态 Auth Broker 与 E2EE 密文队列。 |

---

## 一、已落地核心基座盘点（截至 `v0.1.15` 已验证资产）

Sugent 按「外环私人幕僚（[`docs/PHILOSOPHY.md`](./PHILOSOPHY.md)）× 内环确定性自治底座（[`ARCHITECTURE.md`](../ARCHITECTURE.md)）」演进，在技术源头上融合了 `modelflare-ai/AnyModelBot`、`deepseek-ai/dsh-superagent-prototype` 与 `KKKKhazix/agent-autoloop`。目前已在 [`src/sugent/`](../src/sugent) 落地并通过 `npm run verify:sugent` 契约门禁的六大基座如下：

| 架构域 | 状态 | 已落地核心模块 | 已验证工程能力 |
| :--- | :---: | :--- | :--- |
| **算力解耦与经验自适应路由** | ✅ | [`gateway.ts`](../src/sugent/gateway.ts)、[`provider-registry.ts`](../src/sugent/provider-registry.ts)、[`model-pool-sync.ts`](../src/sugent/model-pool-sync.ts)、[`adaptive-router.ts`](../src/sugent/adaptive-router.ts)、[`routing-experience-store.ts`](../src/sugent/routing-experience-store.ts) | BYOK / CLIProxyAPI `/v1/models` 全量自动同步、非对话模型过滤、429 指数熔断平级秒切、6 类任务原型贝叶斯时间衰减选模、Gemini 4 `thought_signature` 回合粘性锁定（[`2026-11-23 路由方案`](./plans/2026-11-23-adaptive-model-routing-and-cliproxyapi-sync.md)） |
| **五维生命账本与防社死双轨交互** | ✅ | [`stewardship-ledger.ts`](../src/sugent/stewardship-ledger.ts)、[`universal-dropzone.ts`](../src/sugent/universal-dropzone.ts)、[`concierge-guardrails.ts`](../src/sugent/concierge-guardrails.ts)、[`concierge-channel-bridge.ts`](../src/sugent/concierge-channel-bridge.ts) | 关系（`L0–L3` 信任阶梯）· 目标（并发上限 3 条）· 价值（含证伪墓碑）· 事项 · 资源五维活账；四档投递分流与无 API 琐事 `HumanPrepBundle`；群聊禁言与高危外发挂起护栏（[`2026-11-20 幕僚规划`](./plans/2026-11-20-jarvis-personal-os-and-antigravity-bridge.md)、[`P1 方案`](./plans/2026-11-12-p1-opc-wechat-concierge.md)） |
| **注意力漏斗、安全信封与因果溯源** | ✅ | [`kernel.ts`](../src/sugent/kernel.ts)、[`salience-gate.ts`](../src/sugent/salience-gate.ts)、[`executive-arbiter.ts`](../src/sugent/executive-arbiter.ts)、[`security-envelope.ts`](../src/sugent/security-envelope.ts)、[`receipt-protocol.ts`](../src/sugent/receipt-protocol.ts)、[`causal-ledger.ts`](../src/sugent/causal-ledger.ts) | 0 Token 探针 + 四维显著性打分、美元余量与工具 EMA 可靠度仲裁（`POLICY` 拦截不误扣健康分）、只读资料文件防注入、挂起零驻留进程、8 跳级联熔断与 `sugent why` 因果链反查 |
| **双环演进记忆与离线园丁** | ✅ | [`knowledge-graph.ts`](../src/sugent/knowledge-graph.ts)、[`self-improvement-memory.ts`](../src/sugent/self-improvement-memory.ts)、[`memory-gardener.ts`](../src/sugent/memory-gardener.ts)、[`proactive-cadence.ts`](../src/sugent/proactive-cadence.ts) | 统一图谱时效排他边（`exclusive: true`）、跨 BYOK 换模可移植性分级与单点外科隔离回滚（`SugentSIMStore`）、心流边界队列与三档成本封顶离线园丁（[`2026-11-21 演化方案`](./plans/2026-11-21-autonomous-evolution-and-sim-architecture.md)） |
| **Vibe Coding 闭环与 L0–L3 极速热更** | ✅ | [`repo-binding.ts`](../src/sugent/repo-binding.ts)、[`handoff-file-bridge.ts`](../src/sugent/handoff-file-bridge.ts)、[`vibe-coding-pipeline.ts`](../src/sugent/vibe-coding-pipeline.ts)、[`antigravity-bridge.ts`](../src/sugent/antigravity-bridge.ts)、[`hot-core-supervisor.ts`](../src/sugent/hot-core-supervisor.ts)、[`hot-bundle-slots.ts`](../src/sugent/hot-bundle-slots.ts) | Antigravity 三表面只读观测与双向派单、隔离 Worktree + `.sugent-handoff/` 信箱 + `IndependentGateRunner` 客观门禁、薄壳 1–3s Core 热切与 Ed25519 签名 A/B 槽秒级回滚（[`Vibe 方案`](./plans/2026-11-21-vibe-coding-pipeline-and-file-handoff.md)、[`热更方案`](./plans/2026-11-23-hot-start-and-layered-hot-update.md)） |
| **身份聚合、E2EE 同步与团队联邦桥** | ✅ | [`auth-provider.ts`](../src/sugent/auth-provider.ts)、[`e2ee-sync.ts`](../src/sugent/e2ee-sync.ts)、[`byok-diagnostics.ts`](../src/sugent/byok-diagnostics.ts)、[`cowork-bridge.ts`](../src/sugent/cowork-bridge.ts) | `Sugent Auth Broker` OIDC+PKCE 契约（[`P0 方案`](./plans/2026-11-12-p0-sugent-auth-broker.md)）、端侧 AES-256-GCM 记忆/图谱加密同步（[`P2 方案`](./plans/2026-11-12-p2-byok-diagnostics-and-e2ee-sync.md)）、远程 `business-level-cowork` 本体热插拔与移动 HITL 审批桥 |

---

## 二、下一阶段三大核心战役（收敛堵点 · 削平门槛 · 商业打样）

针对实盘代码批判审计（[`2026-11-23 批判报告`](../research/2026-11-23-t3code-landscape-and-sugent-critical-review.md)）识别出的**「双运行时撕裂、宿主主循环未接线、首日空心账本冷启动、笔记本合盖失联悖论、微信 iLink 边界与维护面过宽」**六大堵点，后续研发严禁横向新增概念模块，严格按 **Wave P0 → Wave P1 → Wave P2** 顺序收敛推进：

### Wave P0（第 1–2 周）：内核止血、双脑归一与主循环合龙（零新概念）

**战役目标**：消除 `BotRuntime/DSH` 与 `StewardLlmAgent` 双大脑平行宇宙，把已单测通过的安全与伴行原语 100% 接通进 [`src/app.ts`](../src/app.ts) 真实守护循环，清理破坏“One Jarvis”心智的历史冗余入口。逐任务 TDD 拆解与验收矩阵见 [`docs/plans/2026-11-23-p0-runtime-unification-and-loop-closure.md`](./plans/2026-11-23-p0-runtime-unification-and-loop-closure.md)。

- [x] **P0.1 唯一幕僚大脑跨渠道合龙（消除 Dual-Runtime 撕裂）**
  - 打通微信（`WeixinChannel`）、飞书（`FeishuChannel`）已认证 `owner` 私聊会话直连 [`steward-host-service.ts`](../src/sugent/steward-host-service.ts) 与 [`steward-llm-agent.ts`](../src/sugent/steward-llm-agent.ts)，使手机端对话原生享有五维账本召回、[`adaptive-router.ts`](../src/sugent/adaptive-router.ts) 6 类任务选模、“换更强模型重试”与 Vibe Coding 派单。
  - 明确前后台分工：`StewardLlmAgent` 担任唯一前台参谋与调度中枢；涉及本地终端、大文件编辑、CUA 桌面操控或代码仓修改时，统一作为受控子任务下发至 DSH 工作区或隔离 Worktree 执行，彻底终结“桌面管家与微信 Bot 记忆不通、工具割裂”的体验断层。
- [x] **P0.2 宿主安全信封、主动伴行脉搏与因果账本全量接线**
  - 在 [`src/app.ts`](../src/app.ts) 中使用 [`security-envelope.ts`](../src/sugent/security-envelope.ts) 的 `createEnvelopedRuleEventSink` 正式包裹 `RuleEvents`，杜绝外部规则事件原始 JSON 裸拼入提示词。
  - 在 `App.start()` 中挂载受免打扰与零 Token 探针约束的轻量节律定时器（并在 `App.stop()` 干净销毁），自动驱动早间对齐简报（`drainMorning`）、心流边界队列投递与周度 [`memory-gardener.ts`](../src/sugent/memory-gardener.ts) 巡检。
  - 统一 [`causal-ledger.ts`](../src/sugent/causal-ledger.ts) 存储路径，补齐 [`vibe-coding-pipeline.ts`](../src/sugent/vibe-coding-pipeline.ts) 各阶段事实写入，确保 `npm run sugent:why` 可一键反查任意编码与规则任务全链路。
- [x] **P0.3 历史包袱收敛与技能结晶防污染门禁**
  - 默认收起 UI 中上游遗留的 `Modelflare` 充值线路与“新建多头像 Bot”入口，前台彻底聚焦单一私人幕僚体验；清理闲置静态依赖以降低双上游合并摩擦。
  - 收紧技能结晶门禁：将 [`knowledge-graph.ts`](../src/sugent/knowledge-graph.ts) 满 3 次自动激活 `SKILL.md` 改为先进入 `DreamSandbox` 候选池，经主人单卡确认或客观门禁复核后才挂载进系统提示词，并限制单实例激活技能上限以保护 Prompt Cache 命中率。

**Wave P0 验收门禁（DoD）**：微信/飞书主理人私聊与桌面贾维斯共享同一五维账本与自适应路由决策；`RuleEvents` 100% 经安全信封落盘；`npm run typecheck`、`npm run test:sugent` 与 `npm run verify:sugent` 全绿。

---

### Wave P1（第 3–4 周）：3 分钟零填表冷启动、ACP 异构编码军团与工程防呆

**战役目标**：把新用户首次惊艳时间（Time-to-First-Aha）压缩至 3 分钟以内，同时精准吸收 T3 Code、Paseo、Paradev 与 Pane 已验证的高 ROI 工程机制。

- [x] **P1.1 首日「零填表 3 分钟惊艳」冷启动重塑（破解空心账本劝退）**
  - 首次打开绝不弹出五维账本、信任阶梯或四角色模型配置表单：自动探测本机可用网关/CLI，仅引导用户完成 1 个极简动作——**“拖入 1 个常用项目/合同文件夹，或转发 1 段待办消息”**。
  - 60 秒内自动生成首张本地档案索引卡、提炼首条 `CommitmentItem` 待办承诺，并联动升级版 `sugent try` 演示一次“后台执行 → 挂起零消耗推拍板卡 → 点选完成”的完整闭环，让五维账本在日常使用中无感自生长。
- [x] **P1.2 基于 ACP 标准协议的统一外部智能体适配器（补齐 `CodingHarnessRegistry`）**
  - 放弃为各家 CLI 单独维护脆弱终端解析器的旧方案，新增 `src/sugent/acp-coding-harness.ts` 实现标准 ACP 客户端与参数数组安全调用，注册进 [`repo-binding.ts`](../src/sugent/repo-binding.ts) 的 `CodingHarnessRegistry`。
  - 一次性免改造接入本机 Claude Code、Codex、OpenCode 与 Pi，在 [`vibe-coding-pipeline.ts`](../src/sugent/vibe-coding-pipeline.ts) 中跑通“A 智能体编码 + `IndependentGateRunner` 客观门禁 + B 智能体交叉 Review”，并将预算拆分为**「API 精确美元账本 + 订阅制频次/冷却配额账本」**双轨计量。
- [x] **P1.3 Worktree 隐藏 Git Refs 快照、零膨胀克隆与 PR 行级评论回灌**
  - **隐藏状态快照（借鉴 T3 Code）**：在 Vibe Coding 每轮阶段切换与验证前后，通过 `git write-tree` 与 `git update-ref refs/sugent/checkpoints/<pipelineId>/<round>` 静默打快照——零污染业务分支 `git log`，支持在微信拍板卡与桌面端一键秒退任意轮次，并与 [`self-improvement-memory.ts`](../src/sugent/self-improvement-memory.ts) 的 `attemptId` 绑定。
  - **多 Worktree 磁盘与端口隔离**：初始化隔离 Worktree 时优先采用 macOS APFS `cp -c`（写时复制）或 `pnpm` 硬链接秒级复用 `node_modules`，并自动注入随机空闲端口与独立临时目录环境变量，根治并发脏写与磁盘暴涨。
  - **PR / CI 审查回灌与轻量元素点选（借鉴 Paradev）**：结合 [`delivery.ts`](../src/sugent/delivery.ts) 与 [`handoff-file-bridge.ts`](../src/sugent/handoff-file-bridge.ts)，将 GitHub PR 的 CI 失败日志与 Diff 行级评论经安全信封隔离后自动生成增量补丁投递进 `.sugent-handoff/inbox/`；在桌面本地 Web 预览窗提供轻量 DOM 点选拾取器，一键附带选择器与截图派单改 UI。
- [x] **P1.4 系统权限按需懒加载与 Windows / WSL2 跨文件系统加固（借鉴 Pane）**
  - **系统权限懒授权**：安装包首次启动绝不触发 macOS「屏幕录制 / 辅助功能」系统弹窗，仅在用户首次下达 CUA 桌面操控指令时按需引导授权，降低非技术主理人安装流失率。
  - **Windows + WSL2 专项稳健性**：针对国内政企与工业现场常见的 Windows 宿主机 + WSL2 混合环境，专项验证并修复 `GitWorktreeManager`、`anymodel.lock` 与 [`scripts/safe-relaunch.mjs`](../scripts/safe-relaunch.mjs) 的跨文件系统路径与进程回收逻辑。

---

### Wave P2（第 5–8 周）：合盖离线韧性、微信合规交互流与标杆行业武器包变现

**战役目标**：正面攻克“笔记本合盖断连”与“微信 iLink 协议边界”两大物理堵点，并以 1–2 个高确定性垂直武器包跑通真实商业回款。

- [x] **P2.1 破解「笔记本合盖休眠 vs. 随身微信幕僚」物理悖论**
  - **端侧常驻分级**：在 Electron 托盘提供一键「幕僚值守防休眠（`powerSaveBlocker`）」开关（[`offline-digest-and-power-guard.ts`](../src/sugent/offline-digest-and-power-guard.ts)，含 8 小时电池防榨干硬上限与零句柄泄漏切换），并配套 Mac mini / NAS / GCE 轻量常驻中枢部署套件（[`deploy/gce-hub/`](../deploy/gce-hub)）。
  - **云端 E2EE 离线只读摘要舱与待办暂存队列**：依托无状态 `Sugent Auth Broker` 与 [`e2ee-sync.ts`](../src/sugent/e2ee-sync.ts)，宿主机在线时同步端侧零知识加密的轻量五维账本只读快照（自动剥离本地绝对路径与敏感元数据）；当笔记本合盖离线时，主理人在外出手机端依然能**秒查加密档案摘要、接收临期提醒并将新交办事项压入加密队列**，宿主机开盖瞬间按 Lamport 时钟事务性排空续跑（`0o600` 幂等防重放）。
- [x] **P2.2 微信 iLink 配额自适应保护与「3 秒转发参谋」合规工作流**
  - **严守合规边界**：明确不读取个人微信原生聊天窗口（[`weixin-quota-and-briefing.ts`](../src/sugent/weixin-quota-and-briefing.ts) `COMPLIANCE_MODE = "forwarded_or_screenshot_only"`）；针对客户沟通场景，跑通**「微信合并转发聊天记录 / 聊天截图发给 Sugent → 安全信封物理隔离 → 毫秒级召回客户历史底价与禁忌雷区 → 返回刚性守线 + 范围置换双版本可复制话术」**高频动作。
  - **主动配额水位管理**：实时监测 `WeixinChannel` 主动消息剩余配额（`WeixinAdaptiveQuotaGuard`），低水位（`<= 3`）时自动将多条非紧急通知折叠为单张汇总卡，紧急告警直通附临界提示，配额耗尽或会话过期时平滑降级至飞书备用通道告警。
- [x] **P2.3 打造首个高客单价「端-边联邦标杆武器包（Weapon Package）」**
  - 聚焦高付费意愿、强结果导向的真实场景，基于 [`cowork-bridge.ts`](../src/sugent/cowork-bridge.ts)（`1 × Cowork Hub :28080 + N × Sugent Edge`）在 [`weapon-packages.ts`](../src/sugent/weapon-packages.ts) 完整交付两大标杆武器包与实盘商业证明账本（详细实施方案见 [`2026-11-25 Wave P2 方案`](./plans/2026-11-25-p2-offline-resilience-weixin-briefing-and-weapon-pack.md)）：
    1. **工业现场 FDE 异常诊断与精益数智交付包（`industrial-fde-diagnostics`）**：端侧安全信封密封 MES/ERP 导表批次 + 确定性停机帕累托、SLA 超期与重复热点工位校验 + `CoworkPendingDraftPayload` 待审本体三元组与手机 Staging 审批卡。
    2. **一人公司 / 外贸工作室合同与报价防漏审校包（`opc-contract-quote-guard`）**：对照本地私密历史报价子图与证伪墓碑核验底价、账期及否定式保护条款消歧，生成红线差异卡推送主理人拍板。
  - 配套 `WeaponSoakTelemetryLedger` 持久化追踪连续 14 天常驻实盘压测指标（活跃天数、节省看护工时、模型路由省钱比例、拦截红线数与零越权一票否决门禁）。

---

## 三、长期架构纪律（Permanent Guardrails）

1. **不做低毛利算力二道贩子**：永久保留 `mode: "none"` 免登录离线主权模式与零门槛 BYOK 接入，商业化只向「跨端加密连续性、外出移动中继与高确定性垂直领域武器包」要溢价。
2. **安全门禁永不妥协**：外部不可信输入必须过只读文件信封隔离；任何底层 CLI 调度严禁默认绕过权限围栏；任何自演化插件与规则出现回归时优先执行 `SugentSIMStore` 单件外科隔离并立碑存证。
3. **每增一物必砍一物**：在未完成当前阶段宿主闭环与真实用户体感验证前，严禁向 [`src/sugent/`](../src/sugent) 新增纯概念性模块，确保单人架构师 + Coding Agent 研发团队始终保持极高迭代锐度。
