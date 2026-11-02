# Sugent 架构蓝图 (Architecture & Upstream Fusion Guide)

**Sugent**（Super-Agent）是一个面向“一人公司 / 个人全栈数字主权”打造的全能自治智能体项目。它融合了 [modelflare-ai/AnyModelBot](https://github.com/modelflare-ai/AnyModelBot) 的多端触达、三层记忆与桌面操控基建，以及 [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) 的注意力经济学与 `Intake → Eval → Ticket → Assignment` 领域状态机，底层运行在 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 与开源模型网关 [yetone/magpie](https://github.com/yetone/magpie) 之上。

## 1. 仓库拓扑与“零侵入”上游同步架构

为了在“1 人 + Coding Agent 研发团队”模式下长期平滑跟进两个高频迭代的上游仓库，Sugent 严格采用**三层物理隔离结构**：

```text
sugent/
├── src/
│   ├── sugent/                   # [Sugent 专属核心层] 零侵入扩展：网关解耦、分层路由、自治状态机桥接核
│   │   ├── types.ts              # 统一领域契约（ModelRole / PersonalTrigger / EvalDecision）
│   │   ├── gateway.ts            # 模型网关解耦（BYOK / 订阅账号复用 / 四角色模型路由）
│   │   ├── kernel.ts             # 个人自治状态机门控（Intake -> Eval -> Ticket & 观察模式转正）
│   │   └── index.ts              # 统一导出入口
│   ├── agent/                    # [上游 AnyModelBot] 源自 DS-Bot 的三层 Markdown 记忆与 Context Steward
│   ├── channels/                 # [上游 AnyModelBot] 微信 iLink、飞书、Telegram、Slack、Discord 通道
│   ├── core/                     # [上游 AnyModelBot] DSH 进程守护、持久化 Outbox、免打扰与权限围栏
│   ├── magpie/                   # [上游 AnyModelBot] 内置 magpie 网关守护进程
│   └── tasks/                    # [上游 AnyModelBot] 后台任务、定时规则与 Needs You 阶段状态
├── packages/
│   └── dsh-superagent/           # [上游 dsh-superagent-prototype] 通过 git subtree 完整挂载
│       ├── src/core/             # Intake / Evals / Tickets / Assignments / Replies 事务引擎
│       ├── src/sources/          # SourceKind 插件规范与 GitHub / 飞书事件源实现
│       └── docs/                 # 000-philosophy.md 至 008-cookbook.md 原版设计规范
├── dsh-runtime/                  # [DSH 插件层] Cordis 运行时插件（审批桥接、提示词组装、CUA MCP 过滤）
├── scripts/
│   └── sync-upstreams.mjs        # 一键巡检与同步双上游仓库的自动化脚本
└── test/
    └── sugent.unit.test.ts       # Sugent 专属单元测试契约
```

### 上游同步机制

1. **宿主主干同步（`upstream-amb`）**：根目录直接追踪 `modelflare-ai/AnyModelBot`。所有 Sugent 自研逻辑一律封装在 `src/sugent/` 下，尽量不在上游原文件内做大面积散乱修改，确保 `git merge upstream-amb/master` 零冲突或极低冲突。
2. **自治内核子树同步（`upstream-dsh`）**：`packages/dsh-superagent` 通过 `git subtree` 挂载 `deepseek-ai/dsh-superagent-prototype`，随时通过 `git subtree pull --prefix=packages/dsh-superagent upstream-dsh main --squash` 获取最新状态机与 Source 插件演进。
3. **一键巡检命令**：运行 `npm run sync:upstreams` 查看双上游最新 Commit，运行 `npm run sync:upstreams:merge` 自动执行合并。

## 2. 模型网关解耦与分层路由（Modelflare Decoupling）

上游 `AnyModelBot` 在 `src/magpie/supervisor.ts` 中默认注入了 `MAGPIE_NO_ACCOUNTS=1` 并将 UI 登录绑定到 `modelflare.dev`。Sugent 通过 `src/sugent/gateway.ts` 提供三档解耦能力：

| 模式 (`SUGENT_GATEWAY_MODE`) | 适用阶段 | 工作方式 |
| :--- | :--- | :--- |
| **`external` / `byok`** | 短期立即使用 | 设置 `SUGENT_GATEWAY_URL`（或 `AMB_MAGPIE_BASE_URL`）与 `SUGENT_GATEWAY_KEY`，直接跳过内置 Modelflare 网关与登录，接入本地原版 `magpie`、LiteLLM、OneAPI、Ollama 或任意 OpenAI 兼容接口 |
| **`subscription`** | 中期降本增效 | 设置 `SUGENT_UNLOCK_SUBSCRIPTIONS=1`，解除 `MAGPIE_NO_ACCOUNTS` 限制，直接复用本机已登录的 Claude Code、ChatGPT Plus/Pro、GitHub Copilot、Gemini 订阅额度 |
| **`modelflare`** | 按需保留 | 保持对上游 Modelflare OIDC 与缓存补偿路由的 100% 兼容 |

同时，Sugent 引入**四角色分层模型路由（Role-Based Model Routing）**：
- **`assessor`（守门员）**：使用高性价比极速模型（如 `deepseek/deepseek-chat`）常驻处理 `Intake → Eval` 噪音过滤。
- **`executor`（执行器）**：使用旗舰编程与推理模型（如 `anthropic/claude-sonnet-4-5` / `claude-opus-4-6`）执行已立项的 `Ticket`。
- **`computer_use`（桌面操控）**：为 `Cua Driver` 与 `kimi-computer-use` 指定高精度视觉 GUI 模型。
- **`steward`（记忆管家）**：使用低成本长窗口模型维护三层 `MEMORY.md` 与上下文压缩交接。

## 3. 注意力经济学与个人自治状态机

Sugent 严格遵循 `packages/dsh-superagent/docs/000-philosophy.md` 的核心法则：

> "Take as little human attention as possible, and give as much value as possible."

1. **只听主人的（Owner-Only Gate）**：非白名单发送者的消息在 `evaluatePersonalTrigger()` 阶段直接拦截（`unlisted_sender`），不唤醒模型、不消耗 Token。
2. **观察优先的主动规则（Observation-First Proactive Rules）**：所有未点名的事件流（GitHub 动态、邮件、定时巡检）默认在 `observe` 模式下运行，仅记录“本会做什么（`would`）”；累计无误观察达到阈值（默认 3 次）后，再通过 `shouldSuggestRulePromotion()` 在「需要你」面板提议转正为自动执行（`act`）。
3. **单点结构化升级（Single-Question Escalation）**：后台任务执行期间保持安静，仅在越界审批、预算告警、关键设计分叉或最终交付时，通过持久化 `Outbox` 向主人的微信/飞书推送结构化卡片。
