# Sugent Agent 研发与维护规范 (AGENTS.md)

本仓库由**个人架构师 + Coding Agent 研发团队**全权维护。所有参与本仓库开发的智能体（Claude Code、Codex、DeepSeek Harness、Gemini 等）必须严格遵守以下工程铁律：

## 1. 分支与上游隔离铁律

1. **主分支约定**：本仓库默认主分支为 `main`（远程仓库 `origin` 为 `https://github.com/ldc861117/sugent.git`）。
2. **零侵入扩展原则**：
   - Sugent 的自研核心代码一律放在 `src/sugent/`、测试放在 `test/sugent*.test.ts`、计划文档放在 `docs/plans/`。
   - **严禁**无故大面积重写上游 `AnyModelBot` 的 `src/channels/`、`src/tasks/service.ts` 或 `packages/dsh-superagent/` 内部文件；如需接入宿主流程，优先采用薄适配器（Adapter）或配置注入，以确保 `npm run sync:upstreams:merge` 长期零冲突。
3. **双上游同步**：
   - `upstream-amb`：`https://github.com/modelflare-ai/AnyModelBot.git`（宿主底座）
   - `upstream-dsh`：`https://github.com/deepseek-ai/dsh-superagent-prototype.git`（挂载于 `packages/dsh-superagent`）

## 2. 编码与设计准则

1. **遵循注意力经济学**：认真阅读 `packages/dsh-superagent/docs/000-philosophy.md` 与 `ARCHITECTURE.md`。能用 Prompt、`SKILL.md` 或合理默认值解决的问题，绝不新增多余的 UI 开关或冗余概念（*Few concepts. Few settings.*）。
2. **模型网关中立性**：所有新增的模型调用必须支持通过 `src/sugent/gateway.ts` 按角色（`assessor` / `executor` / `computer_use` / `steward`）路由，不得硬编码绑定单一供应商。
3. **测试驱动与提交门禁**：
   - 任何代码改动完成后，必须运行 `npm run typecheck`、`npm run test:sugent` 与 `npm run verify:sugent`。
   - 类型检查与测试未 100% 通过前，严禁宣称任务完成或推送到远程分支。

## 3. 商业化战略护栏与迭代自省铁律

1. **BYOK 算力自由与灰盒实验隔离（BYOK First, Compliance Always）**：
   - **商业化主航道**：让用户零门槛自配任意正规模型 API（OpenAI / Anthropic / DeepSeek / Gemini / Ollama / 企业网关）是商业版的永久基石；Sugent 靠**自治工作流、防社死安全边界、跨端加密记忆同步、移动审批中继与行业武器包**创造商业溢价，绝不靠锁死算力渠道赚模型差价。
   - **实验适配器隔离**：任何依赖网页逆向会话或非官方接口的实验性组件（如 `gemini-web2api` 适配器）仅允许作为可选极客插件存在，**严禁**设为商业安装包默认引导项、核心营销卖点或强依赖，规避上游风控封号与法务连带风险。
2. **统一身份聚合与算力正交解耦（Auth Broker for Identity, Local Sovereignty Intact）**：
   - 多平台登录（微信、Apple ID、Google、飞书、钉钉等）统一收口至云端无状态 **`Sugent Auth Broker`**，向下游托管各平台客户端密钥与备案回调域名，向上游通过单一标准 OIDC + PKCE 协议向桌面端签发通行证（承载会员权益、加密云同步与团队组织身份）。
   - **主权退路红线**：任何商业化账户或云服务能力均不得破坏 `mode: "none"` 免登录离线主权模式——未登录或云端不可达时，本地 BYOK 对话、规则巡检、安全信封与本地预算账本必须 100% 独立可用。
3. **新特性「商业策略自省四问」门禁（Pre-Plan Commercial Reflection Gate）**：
   - 每次编写 `docs/plans/*.md` 新功能规划或更新路线图前，必须在方案头部显式回答以下四问，未通过自省的需求退回重审：
     1. **付费锚点（Why Pay & Moat）**：它属于“开源引流基座”还是“商业付费增值”？相比大厂办公全家桶（WorkBuddy、千问办公等），它是否放大了 Sugent 的跨生态中立性、本地隐私主权或防社死确定性优势？
     2. **合规与分发（Distribution & ToS Risk）**：它能否顺利通过 macOS 公证 / Windows 签名 / 企业安全审计？是否包含硬编码客户端密钥或第三方平台封禁隐患？
     3. **离线退路（Sovereignty Fallback）**：剥离云端账号后，单机 BYOK 核心闭环是否依然完整自洽？
     4. **一人公司运维杠杆（OPC Ops Leverage）**：是否符合“无状态边缘服务 + 端侧重逻辑”原则，确保单人架构师与 Agent 团队的日常运维负担趋近于零？


## 5. 状态卡与规划文档落盘规范（Antigravity & Gemini App Task 模式通用）

当通过本地文件夹挂载（如 Gemini App `Task` 模式 Connected Folders 或 Antigravity）推进本仓时，必须遵守以下文件闭环规则：
1. **开工必读**：动手前先读根目录 `STATUS.md`（若存在）与 `docs/ROADMAP.md`，对齐当前阶段目标与红线，不脱离现有路线另起炉灶。
2. **过程落盘**：调研与实施方案统一写入 `docs/plans/YYYY-MM-DD-<topic>.md`；关键架构取舍或避坑结论追加至 `docs/decisions/steward-notes.md`；完成既定里程碑子项时同步勾选 `docs/ROADMAP.md`。
3. **收工必更 `STATUS.md`**：每完成一轮关键规划/实施交付或用户说“收工”时，直接新建或更新仓库根目录 `STATUS.md`（YAML frontmatter 置 `status_version: 1`、`project: sugent`、`review_state: pending_review`、`updated_by: gemini-task@local-mac` 或 `agent@<node_id>`、`updated_at: <ISO时间>`，`confirmed_by`/`confirmed_at` 留空；正文包含 `## 阶段目标` ≤30字不写项目介绍、`## 最近完成`、`## 在途`、`## 下一步`、`## 卡点` 五节）。严禁自行置 `confirmed`，严禁触碰 `.env` 密钥或未经确认擅自 `git push`。
