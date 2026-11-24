# Sugent 生态位战略研判、深度批判审计与前瞻堵点攻关报告

**报告日期**：2026 年 11 月 23 日  
**评估基线**：Sugent `v0.1.15`（`src/sugent/` 共 61 个自研模块，参考前期基线审计 [`01-sugent-baseline-audit.md`](./2026-11-21-autonomy-and-evolution/01-sugent-baseline-audit.md)）  
**对标参照系**：T3 Code (`pingdotgg/t3code`)、Paseo (`getpaseo/paseo`)、Paradev (`ParadevAI/Paradev`)、Pane、Emdash (`generalaction/emdash`)、Conductor、Orca 及主流原生编程智能体

---

## 一、执行摘要与核心定论

围绕 T3 Code 等多智能体控制面（Agentic Control Plane）赛道的兴起，结合对 Sugent 源码仓库（[`src/app.ts`](../src/app.ts)、[`src/sugent/`](../src/sugent)、[`electron/`](../electron) 及 [`docs/ROADMAP.md`](../docs/ROADMAP.md)）的逐层交叉审查，本报告给出三项核心判断：

1. **生态位定标（错位升维而非同层内卷）**：T3 Code、Paseo 与 Paradev 处于**围绕 Git 代码仓（Repo-Centric）生长的「L2 开发者编码并发切换台」**；Sugent 则处于其正上方的**围绕具体个人与小微组织（Person / OPC-Centric）生长的「L3 本地主权幕僚 OS × 端-边治理总线」**。对 Sugent 而言，多 CLI 编码只是其后台调遣的特种兵团之一，而非产品的全部前台。
2. **战略价值判定（直击竞品两大盲区，但严禁滑向同质化编码壳）**：纯本地多 CLI 编码壳赛道已陷入开源免费肉搏与商业化困局（Conductor 云服务已于 2026 年 11 月 20 日关停、Emdash Classic 停止新特性开发转向闭源商业版）。Sugent 的真正护城河在于用确定性治理消解 T3 Code 无力根治的**「多 Agent 看护税（Babysitting Tax）」**，并通过**「微信/飞书随身交互 + 原生桌面 GUI 操控 + 小微团队 Cowork 本体联邦」**切入一人公司（OPC）主理人与工业现场工程师（FDE）的高溢价闭环。
3. **批判性红牌预警（61 个模块背后的结构性隐患）**：Sugent 当前最大的风险不在外部竞品，而在内部的**「架构超前于接线、概念超载于体感」**。实盘代码审计暴露出四大紧迫病灶：**双运行时平行宇宙撕裂**（`BotRuntime/DSH` 与 `StewardLlmAgent` 各自为政）、**核心安全与主动伴行原语在 `src/app.ts` 中未全量合龙**、**笔记本合盖休眠与“微信 24 小时随身幕僚”承诺的物理悖论**，以及**首日空心账本导致的冷启动高认知门槛**。若不先做工程收口与交互减法，单人维护半径将被迅速击穿。

---

## 二、全景赛道解构与 Sugent 生态位坐标

### 2.1 2026 年底智能体工具栈的四层解耦视角

当前智能体基础设施可拆解为职责分明的四层，混淆层级会导致严重的产品定位失焦：

- **L0 算力与模型路由网关层（Gateway Layer）**：负责多供应商协议转换、预算硬上限、熔断与成本归因，代表项目如 `yetone/magpie` 及各类企业网关。
- **L1 执行引擎层（Harness Layer）**：负责单智能体的「模型推理 → 工具调用 → 环境反馈」循环，代表产品包括 Claude Code、OpenAI Codex、Cursor、DeepSeek Harness 及原生桌面操控驱动 CUA (`trycua/cua`)。
- **L2 开发者代码仓控制面（Repo-Centric Orchestrator Layer）**：以「1 个编码任务 = 1 个 Git Worktree + 1 个 CLI 会话」为组织原则，通过 Agent Client Protocol (ACP) 或终端包装器并发管理多个 L1 编码工具，代表产品即 T3 Code、Paseo、Paradev 与 Pane。
- **L3 个人主权幕僚与端-边治理层（Person-Centric Sovereign Steward Layer）**：Sugent 所处的真实生态位——向上承接主理人在微信、飞书与桌面的全天候非结构化意图，中间以五维生命账本、显著性降噪门控与防社死护栏做跨周期决策仲裁，向下按需调遣 L0 自适应路由、L1 桌面操控以及 L2 隔离 Worktree 编码流水线，并向外通过 [`src/sugent/cowork-bridge.ts`](../src/sugent/cowork-bridge.ts) 对接团队本体治理。

### 2.2 核心竞品与 Sugent 深度横向对比矩阵

| 产品 / 阵营 | 生态位层级与开源模式 | 核心交互与锚点 | 关键差异化长板 | 真实短板、合规隐患与商业瓶颈 |
| :--- | :--- | :--- | :--- | :--- |
| **T3 Code** (`pingdotgg/t3code`) | L2 代码仓控制面（MIT，T3 Connect 需账号） | 跨端对话流收件箱 + 手机远程审批，围绕 Git Worktree 运转 | UI 响应极快、跨 Agent 线程无缝交接、隐藏 Git Checkpoint、原生双端移动体验完整 | 仍处 `v0.1.x` 快速迭代期；无法消除 Agent 跑偏看护成本；第三方订阅鉴权易失效且存平台风控隐患；WSL2 成熟度偏弱 |
| **Paseo** (`getpaseo/paseo`) | L2 代码仓控制面（Apache-2.0，独立全职维护） | 本地 Daemon + 桌面/移动/Web/CLI，兼容 40+ 工具与 ACP 协议 | 零遥测免登录、自带本地语音交互、跨端插件扩展性强 | 单人维护抗风险能力受限；界面信息密度过高，非极客用户上手心智负担重 |
| **Paradev** (`ParadevAI/Paradev`) | L2 团队编码控制面（MIT 本地免费，远程/团队订阅付费） | 内置浏览器 + Worktree 并行 + PR/CI 深度审查工作流 | 浏览器 Design Mode 点选元素改 UI、CI 报错与 PR 行级评论直接喂回 Agent、CLI/SDK/MCP 自动化完备 | 无 Windows 版（Linux 仅实验支持）；移动端与远程主机锁在 Pro 付费墙（$20/月起）内 |
| **Pane** | L2 终端原生控制面（AGPL-3.0，免账号） | Terminal-first 分屏保留各 CLI 原生界面 | Windows 与 WSL2 原生支持度最佳，终端极客零学习迁移成本 | 交互形态偏底层终端，缺乏跨任务高层语义综合与非研发场景能力 |
| **Emdash** (`generalaction/emdash`) | L2 工单驱动控制面（Apache-2.0 Classic 版 + 闭源 2.0） | 直接将 Linear / Jira / GitHub Issue 派入本地或 SSH 远端 Worktree | 外部研发工单系统连接器最丰富，天然贴合传统敏捷开发流 | 团队重心已转向闭源商业版 Emdash 2.0，开源版仅维持基础修复，社区信任受损 |
| **Orca** (`orca.dev`) | L2 编码集成环境（官网标称开源，仓库透明度存疑） | Electron 集成终端、编辑器、浏览器与云端连接器 | 预置 40+ Agent 配置，开箱打通 Slack / Linear 触发 | 第三方实测显示其默认预填跳过权限审批参数，存在宿主机凭证暴露隐患；默认开启遥测且开源仓 404 引发信任危机 |
| **Conductor** | L2 先驱参照系（闭源，已被 Meta 收购） | macOS 原生多 Worktree 并行编排标杆 | 早期交互打磨最精致的 macOS 多 Agent 协同范本 | 2026 年 11 月初并入 Meta，Conductor Cloud 已于 11 月 20 日彻底关停（虽于 11 月 12 日表态本地端暂恢复更新，但战略独立性已丧失） |
| **原生垂直客户端**（Claude Code / Cursor / Codex） | L1+L2 垂直一体化（闭源商业订阅） | 官方桌面壳、IDE 内置后台 Agent 或官方托管云沙箱（如 Claude Duet） | 零第三方 ToS 封号风险、云端托管 VM 支持合盖异步运行与自动修 CI | 强生态锁定，无法跨厂商自由混排异构 CLI 或守住纯本地离线隐私主权 |
| **Sugent（本项目）** | **L3 个人主权幕僚 × 端-边治理总线**（MIT Open-Core） | 融合 AnyModelBot 多 IM 入口与 `dsh-superagent` 注意力哲学的唯一幕僚前台 | 五维账本 + 防社死护栏 + 经验驱动自适应选模 + 跨模型 SIM 演进记忆 + 微信 iLink / 飞书拍板 + CUA 桌面操控 + Cowork 团队本体联邦 | **双运行时架构尚未统一、部分自治原语未接入主循环、外部 ACP 编码器缺位、合盖休眠断连及首日冷启动概念偏重** |

---

## 三、Sugent 的不可替代价值与核心护城河

从商业终局与用户真实痛点审视，Sugent 的核心价值不在于“比 T3 Code 多支持几个模型”，而在于以下三道竞品难以跨界复制的结构性壁垒：

1. **用「确定性治理 + 跨模型演进记忆」消解多 Agent 看护税**：
   T3 Code 与 Paseo 解决了“同时启动 5 个编码 Agent”的问题，却放大了人类主理人的注意力碎片化——用户不得不充当人肉路由器与人肉监工。Sugent 通过 [`sources.ts`](../src/sugent/sources.ts)（零成本探针）→ [`salience-gate.ts`](../src/sugent/salience-gate.ts)（四维显著性打分）→ [`executive-arbiter.ts`](../src/sugent/executive-arbiter.ts)（目标并发上限 3 条、美元余量与工具 EMA 可靠度门禁）→ [`receipt-protocol.ts`](../src/sugent/receipt-protocol.ts)（挂起零驻留进程与 8 跳级联熔断）构建了严密的注意力漏斗；同时引入 [`adaptive-router.ts`](../src/sugent/adaptive-router.ts)（贝叶斯时间衰减后验路由）与 [`self-improvement-memory.ts`](../src/sugent/self-improvement-memory.ts)（记录改动假设、预测偏差与模型可移植性分级），解决切换 BYOK 模型后历史调优失忆退化的顽疾。
2. **跳出纯程序员圈层，打通「IM 社交入口 + 原生桌面 GUI + 现实事务前 80% 兜底」**：
   现实中一人公司主理人、独立顾问与现场工程师 70% 的高摩擦事务发生在 Git 仓库之外：微信客户询价核对历史合同、老旧工业/ERP 桌面软件导表（依赖内置 CUA 与 `kimi-computer-use`）、政务或报销材料准备（`HumanPrepBundle`）。Sugent 借助 `Tencent/openclaw-weixin` 与飞书流式卡片嵌入高频随身入口，并用 [`concierge-guardrails.ts`](../src/sugent/concierge-guardrails.ts) 锁死群聊乱说话与报价越权风险，这是纯英文极客向编码控制面完全空白的地带。
3. **拥有比“卖云中继月费”更厚实的 B2B 端-边商业化纵深**：
   同赛道开源竞品普遍困于单一远程穿透月费（极客直接用 Tailscale 绕过）。Sugent 在 [`AGENTS.md`](../AGENTS.md) 中确立了「算力彻底开放（BYOK 永久免费支持）+ 商业溢价锚定身份协同、E2EE 记忆漫游与领域武器包」的正交路线，特别是 [`cowork-bridge.ts`](../src/sugent/cowork-bridge.ts) 支持的 **`1 × Cowork Hub (:28080) + N × Sugent Edge`** 动态联邦模式：插上员工密钥即可拉取企业版本化本体武器包、将端侧经验提交至 Staging 缓冲池，并把高风险 `EXTERNAL_COMMIT` 操作推送到专家手机微信/飞书审批，天然契合 3–50 人工业 FDE 团队、外贸工作室与法务咨询机构的私有化数字员工交付。

---

## 四、深度批判审计：当前项目的六大结构性病灶与认知陷阱

剥离愿景滤镜，直接以严苛视角审视 `v0.1.15` 代码实现，项目存在六处不容回避的结构性病灶：

### 4.1 病灶一：「双大脑平行宇宙」架构撕裂（Dual-Runtime Split-Brain）

打开 [`src/app.ts`](../src/app.ts) 可以看到两套近乎平行的智能体运行宇宙共存于同一进程：

- **第一宇宙（上游 AnyModelBot 宿主引擎）**：由 `BotRuntime` + `AgentManager`（底层拉起 `@deepseek-ai/dsh` 子进程并经 `magpie` 转发）+ `TaskService` + `Store("anymodel.db")` 组成。**目前微信（`WeixinChannel`）、飞书（`FeishuChannel`）与 Telegram/Slack 收到的日常聊天消息，默认全部流向这套旧引擎**（仅在回复出站前挂了一层 `conciergeIntercept` 薄拦截）。
- **第二宇宙（Sugent 自研管家引擎）**：由 `SugentStewardHostService` + [`steward-llm-agent.ts`](../src/sugent/steward-llm-agent.ts)（Node.js 内自建最多 5 轮的 `/chat/completions` HTTP 工具循环）+ `AdaptiveModelRouter` + `StewardshipLedger` + `VibeCodingPipelineOrchestrator` 组成，主要服务 `/amb/api/steward/*` 与桌面端「贾维斯工作台」。
- **撕裂后果**：当主理人在微信里跟机器人对话时，既没有直接享受到 `StewardLlmAgent` 的 6 类原型自适应选模与“一键换更强模型重试”，也无法无缝驱动 `VibeCodingPipeline`；反过来，当用户在桌面贾维斯工作台与 `StewardLlmAgent` 对话时，它又拿不到 DSH 子进程里成熟的沙箱终端、文件编辑与 CUA 桌面操控工具。两套大脑各自维护上下文与计费入口，极易造成体验割裂。

### 4.2 病灶二：「模块库丰裕」掩盖了「主循环未合龙」（Library-Rich, Loop-Incomplete）

Sugent 在 [`src/sugent/`](../src/sugent) 下虽已沉淀 61 个模块且单测扎实，但核查 [`src/app.ts`](../src/app.ts) 的真实运行链路仍有多处悬空断点：

- **防注入安全信封未接管宿主规则流**：[`security-envelope.ts`](../src/sugent/security-envelope.ts) 实现了只读文件物理隔离与 `createEnvelopedRuleEventSink`，但 [`src/app.ts`](../src/app.ts) 第 436 行依然直接实例化裸的 `this.ruleEvents = new RuleEvents(this.tasks)`，外部规则事件仍以原始 JSON 字符串形式拼入任务提示词。
- **主动伴行与记忆园丁缺乏后台脉搏**：[`proactive-cadence.ts`](../src/sugent/proactive-cadence.ts)（早间简报、心流间隙投递、偏航检测）与 [`memory-gardener.ts`](../src/sugent/memory-gardener.ts)（周度校准、墓碑结晶、图谱修剪）均已实现核心逻辑，但在 `App.start()` 方法中仅启动了 `picksTimer`、`modelPoolSyncTimer` 与 `accountTimer`，缺少自动触发早间对齐简报与周度园丁巡检的后台定时器。
- **静态子树闲置**：`packages/dsh-superagent` 通过 `git subtree` 完整挂载，但宿主实际运行的仍是 `AnyModelBot` 的 `TaskService`，原生事务引擎并未接管业务流，增加了仓库体积与概念负担。

### 4.3 病灶三：「零侵入双上游同步」的长期幻觉与历史包袱

[`AGENTS.md`](../AGENTS.md) 规定严守 `src/sugent/` 零侵入边界以保障一键无冲突合并，但 [`src/app.ts`](../src/app.ts)（近 70KB）、`src/web/server.ts`、`electron/main.ts`、`package.json` 及 `ui/` 已深度织入 Sugent 自研状态。一旦上游 `AnyModelBot` 对 `App` 类生命周期或数据库表结构做结构性重构，合并必发语义冲突；同时界面残留的 `Modelflare` 计费线路与“新建多个不同头像 Bot”入口直接削弱了 **「One Jarvis 前台唯一人格」**（[`docs/PHILOSOPHY.md`](../docs/PHILOSOPHY.md)）的心智纯粹度。

### 4.4 病灶四：概念密度过载与「首日空心账本」冷启动劝退

对照 T3 Code 60 秒即装即用的极简路径，Sugent 向新用户抛出了极高的概念密度：五维生命账本、北极星目标、L0–L3 信任阶梯、证伪墓碑、Tier 0–2 动态隐私纪元、SIM 演进记忆、自适应路由策略、Universal Dropzone、Vibe Coding、Cowork 联邦。在首日五维账本为空时，显著性门控、防偏航与墓碑预警全部缺乏数据燃料而空转，若不能在前 3 分钟零手动填表内兑现“首次惊艳时刻”，新用户极易在体会长期复利前流失。

### 4.5 病灶五：重装二进制堆叠与多层进程树脆弱性

安装包同时捆绑了 Electron 44 外壳 + Node 受管 Core 子进程（[`hot-core-supervisor.ts`](../src/sugent/hot-core-supervisor.ts)）+ Go 编译的 `magpie` 网关守护进程 + `dsh.asar` 内的 `@deepseek-ai/dsh` 运行时子进程 + `cua-driver` 原生二进制 + `kimi-computer-use` 脚本层及外部 `agentapi`/`git` 进程。5 至 6 层跨语言进程树带来了可观的内存常驻开销、异常退出的文件锁（`anymodel.lock`）竞争风险与跨平台排障成本。

### 4.6 病灶六：商业化「三明治夹心层」挤压风险

- **向下被开源极客白嫖**：技术极客直接使用 `mode: "none"` + 自建 CLIProxyAPI + Tailscale 组网，几乎不会为云中继付费。
- **横向被办公巨头原生特权挤压**：飞书智能伙伴、钉钉 AI 助理、企业微信与海外 Claude Duet 握有第一方聊天上下文、日历与组织架构免授权直读特权。
- **向上遭遇小微企业结果导向拷问**：工业 FDE 或外贸老板只为“抓出老 ERP 异常单算准交期且零差错”的结果买单，缺乏开箱即用的垂直武器包样板就难以兑现高客单价。

---

## 五、前瞻堵点与硬核工程难点清单（提前识别未来 1–6 个月深坑）

| 编号 | 堵点与难点名称 | 触发场景与底层机理 | 严重等级 | 破局方向与工程预案 |
| :--- | :--- | :--- | :---: | :--- |
| **堵点 1** | **宿主机合盖休眠 vs. 「微信随身幕僚」物理悖论** | 主理人带着笔记本外出合盖或家里电脑休眠，本机进程与微信长轮询挂起；此时客户发消息或手机端想“秒翻家底”，系统彻底失联。 | **P0 致命** | 1. 桌面端内置防休眠常驻开关（`powerSaveBlocker`）并明确引导 Mac mini / NAS / 常驻工位机部署；<br>2. 云端无状态中继层增加 **E2EE 离线收件队列 + 轻量加密只读账本摘要舱**，宿主机离线时手机仍可秒查摘要并暂存待办，唤醒后自动拉取续跑。 |
| **堵点 2** | **微信 iLink 协议边界、配额卡死与私聊上下文盲区** | `Tencent/openclaw-weixin` 仅能接收直接发给该 Bot 的消息，**无法合法读取主理人与客户的原生私人微信聊天窗或群聊**；且存在未互动窗口主动推送配额（`quota`）上限与登录态过期重扫问题。 | **P0 致命** | 1. 严守合规红线，严禁采用非官方客户端注入手段；<br>2. 打磨极致顺手的**「微信合并转发 / 截图一键丢给幕僚 → 3 秒回传背景小抄与拟回复话术」**交互流；<br>3. 监控 `quota.remaining` 低水位自动合卡降频，超限平滑切换飞书/邮件备用通道。 |
| **堵点 3** | **macOS 系统隐私弹窗连环劝退与 Windows 签名声誉** | CUA 桌面操控需申请「辅助功能 + 屏幕录制」系统权限，macOS 15+ 按月重复弹窗提醒；Windows 新签名程序模拟输入易触发系统安全警告。 | **P1 高危** | 1. **权限懒加载（Lazy Permission Granting）**：首次安装启动零敏感权限弹窗，仅在首次触发桌面操控任务时图文引导按需开启；<br>2. 尽早跑通 Apple 公证与 Windows 代码签名声誉积累，将 CUA 设为按需启用扩展。 |
| **堵点 4** | **多 Git Worktree 并发下的「非文件状态污染」与磁盘暴涨** | `GitWorktreeManager` 只隔离了源码文件，未隔离 `.env`、本地端口（`:3000`）、共享 SQLite 及 Docker 容器；且每个 Worktree 执行依赖安装会瞬间吃掉数 GB 磁盘。 | **P1 高危** | 1. Worktree 初始化支持 macOS APFS `cp -c`（写时复制克隆）或 `pnpm` 硬链接秒级复用 `node_modules`；<br>2. 在 [`repo-binding.ts`](../src/sugent/repo-binding.ts) 注入动态空闲端口环境变量与独立测试临时目录。 |
| **堵点 5** | **异构 CLI 交接的「上下文坍缩」与订阅成本失真** | 从 Antigravity 切换到 Claude Code 或 Codex 时，各工具内部推理链互不可见，仅靠文件信箱易漏掉隐性架构约束；且包月 CLI 不返回 API Token 账单，导致 `LocalBudgetLedger` 失真。 | **P1 高危** | 1. 强制规范 `.sugent-handoff/`（[`handoff-file-bridge.ts`](../src/sugent/handoff-file-bridge.ts)）自动附带 `git diff --stat`、相关墓碑条款与失败单测输出尾部；<br>2. 账本拆分为**「API 精确美元账本 + 订阅制调用频次/冷却配额账本」**双轨计量。 |
| **堵点 6** | **自主技能结晶与 SIM 的「伪规律固化」污染** | `SKILL_CRYSTALLIZE_THRESHOLD = 3` 仅按次数判定，可能把三次偶然凑巧跑通的脆弱步骤结晶成 `SKILL.md` 注入系统提示词，破坏 Prompt Cache 并误导后续任务。 | **P2 中高** | 1. 结晶门禁从“满 3 次自动落盘激活”收紧为**“满 3 次进 `DreamSandbox` 候选 → 经主人单卡确认或客观验证通过才正式挂载”**；<br>2. 严格限制单实例激活技能总数上限并按命中率自动淘汰。 |
| **堵点 7** | **一人公司研发维护面过宽（OPC Ops Ceiling）** | 同时维护双上游同步、61 个自研模块、Electron 跨平台构建、多 IM 渠道、Auth Broker 与 Cowork 联邦，极易耗尽单人架构师精力。 | **P0 致命** | 坚决执行**架构收敛与模块冻结**：用 ACP 标准协议把编码执行层外包给成熟 CLI 生态，把 80% 研发火力集中到“唯一幕僚交互体验 + 1 个标杆行业武器包”。 |

---

## 六、竞品精华吸收蓝图：借什么、怎么改、坚决不碰什么

- **【立即吸收】借 T3 Code 与 Paseo 的 ACP 标准协议，一次性补齐外部编码器适配**：放弃为 Claude Code、Codex、OpenCode、Pi 逐一编写命令行文本解析器的重维护方案，实现统一的 `AcpCodingHarness` 注册进 [`repo-binding.ts`](../src/sugent/repo-binding.ts) 的 `CodingHarnessRegistry`。
- **【立即吸收】借 T3 Code 的「隐藏 Git Refs 快照（Hidden Checkpoints）」强化 Vibe Coding 可逆性**：在 [`vibe-coding-pipeline.ts`](../src/sugent/vibe-coding-pipeline.ts) 每轮阶段流转与门禁复核前后，执行 `git write-tree` 与 `git update-ref refs/sugent/checkpoints/<pipelineId>/<round>`，不污染业务分支历史即可一键秒退至任意健康轮次。
- **【改造吸收】借 Paradev 的「PR / CI 行级评论回灌」与轻量 DOM 拾取器**：结合 [`delivery.ts`](../src/sugent/delivery.ts) 与 [`handoff-file-bridge.ts`](../src/sugent/handoff-file-bridge.ts)，将 PR 失败日志与行级评论经安全信封清洗后自动喂回原 Worktree，并在桌面预览窗支持轻量元素点选带截图派单。
- **【改造吸收】借 Paseo 零遥测信任状与 Pane 的 Windows / WSL2 稳健性**：显著承诺 `mode: "none"` 离线零遥测能力，专项加固 Windows + WSL2 下的跨文件系统路径与重启看门狗。
- **【坚决不碰】拒绝默认绕过权限围栏与第三方灰盒订阅强绑定**：严禁默认关闭底层 CLI 权限确认，严守 [`AGENTS.md`](../AGENTS.md) 商业合规隔离红线。

---

## 七、分阶段收敛与突围路线（详见新版 [`docs/ROADMAP.md`](../docs/ROADMAP.md)）

1. **Wave P0（第 1–2 周 · 止血合龙与双脑归一，零新概念）**：打通微信/飞书主理人私聊直连 `StewardLlmAgent` 唯一幕僚大脑；在 [`src/app.ts`](../src/app.ts) 补齐 `RuleEvents` 安全信封包裹与早报、周度园丁后台定时器；默认收起冗余多 Bot 与 `Modelflare` 遗留入口。
2. **Wave P1（第 3–4 周 · 3 分钟冷启动削峰、ACP 异构军团与工程防呆）**：重塑拖入文件夹 60 秒自动建账体验；落地 `AcpCodingHarness`、Worktree 隐藏 Git Refs 快照与 APFS 克隆省空间安装；落地 CUA 权限按需懒加载与 WSL2 兼容加固。
3. **Wave P2（第 5–8 周 · 合盖离线韧性、微信合规流与标杆武器包变现）**：落地桌面防休眠模式 + 云端 E2EE 离线只读摘要舱与微信配额自适应保护；基于 `1 × Cowork Hub (:28080) + N × Sugent Edge` 封装首个付费行业武器包（工业现场 FDE 异常诊断或合同报价防漏审校）并完成 14 天全天候实盘压测。
