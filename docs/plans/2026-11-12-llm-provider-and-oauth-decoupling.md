# Sugent LLM Provider 与账户 OAuth 彻底解耦实施方案

**目标（Goal）：** 解除 Sugent（继承自 AnyModelBot）在模型网关、模型定价目录、机器人预算控制、首次启动引导（Onboarding）与账户 OIDC 登录上对 Modelflare 的强绑定，实现**默认免登录本地主权运行（BYOK / 本地模型 / CLI 订阅直连）**与**可插拔标准 OIDC / OAuth 身份联邦**。

**核心架构（Architecture）：**
遵循 `src/sugent/` 零侵入扩展原则，将当前耦合在 `src/modelflare.ts`、`src/magpie/supervisor.ts`、`src/account/*` 与 `ui/screens/*` 中的逻辑拆解为两个正交平面：
1. **多供应商模型路由与本地计费平面（LLM Provider & Local Catalog Plane）**：新增 `src/sugent/provider-registry.ts` 与 `src/sugent/model-catalog.ts`，接管多 Provider CRUD（OpenAI、Anthropic、DeepSeek、Gemini、OpenRouter、Ollama、Cowork 网关及自定义端点），内置静态主流模型能力/单价表并支持自定义覆盖，用本地 SQLite 账本替代远程 `mfb-<botId>` 子密钥来做机器人级月度/单任务预算熔断。
2. **可插拔身份与 OAuth 平面（Identity & OAuth Plane）**：将 `src/account/oauth.ts` 中的标准 RFC 8252 + PKCE 能力提炼为通用 `src/sugent/auth-provider.ts`，支持三种身份模式：`none`（默认个人主权免登录）、`oidc`（对接任意企业/团队 IdP 或 Cowork/New-API 签发网关令牌）、以及 `modelflare-compat`（可选兼容适配器，保持旧配置平滑迁移）。

**技术栈（Tech Stack）：** TypeScript (ESM, Node >= 22.13), SQLite (`node:sqlite`), Magpie 本地多供应商网关, Preact + htm 前端单页控制台, Vitest。

## 一、现状耦合点全景审计

| 耦合维度 | 现有耦合文件与位置 | 具体锁定表现 | 解耦后目标机制 |
| :--- | :--- | :--- | :--- |
| **供应商白名单锁死** | `src/magpie/supervisor.ts:455-469`、`src/modelflare.ts:9-15` | `upsertProvider()` 强制检查 `allowed.includes(baseUrl)`，非 Modelflare 国际/国内域名直接抛 `unsupported_url`；Provider ID 写死 `modelflare` | 放开任意合法端点与内置预设模板（OpenAI / Anthropic / DeepSeek / Ollama / Cowork），支持多 Provider 并存与按角色路由 |
| **CLI 订阅发现被禁用** | `src/magpie/supervisor.ts:144-169` | 默认注入 `MAGPIE_NO_ACCOUNTS=1` 与 `noAccountDiscovery: true`，屏蔽本机已登录的 Claude / Codex / Gemini 订阅凭据 | 在 `ProviderRegistry` 中将「本机订阅账号发现」作为一等公民开关，可在设置页一键启停 |
| **模型能力与单价黑盒** | `src/account/model-info.ts:128-162`、`src/app.ts:211-216` | 上下文窗口、`endpoints`（Anthropic Messages / OpenAI Responses）与 Token 单价仅从 Modelflare `/model-profiles` 和 `/api/pricing` 拉取；外部模式下 Claude 被迫退化走 Chat Completions 且无法估算任务成本 | 新增 `src/sugent/model-catalog.ts`：内置主流模型家族静态能力与参考单价表 + `/v1/models` 动态合并 + 用户自定义单价覆盖 |
| **机器人预算绑死远程登录** | `src/account/manager.ts:297-331`、`src/app.ts:402-432` | 给单个 Bot 设花费上限必须先登录 Modelflare 并在远端签发 `mfb-<botId>` 子 Key；未登录直接报 `409 budget_needs_login` | 新增本地 SQLite 预算账本（`src/sugent/local-budget.ts`）：直接基于每次回合/任务 Token 用量 × 本地单价表实时扣减并触发 80% 预警与 100% 停机保护，零云端账号依赖 |
| **桌面首次引导强制登录** | `ui/screens/onboarding.js:180-221`、`src/web/server.ts:357-399` | 本机回环访问时默认只展示「登录 / 注册 Modelflare」主按钮，只有远程非回环部署才降级展示粘贴 Key | 重构首次引导页为「选择模型接入方式」：1) 粘贴任意 Provider API Key；2) 连接本地 Ollama / 外部网关；3) 开启本机订阅复用；4) 可选企业 OIDC 登录 |
| **OIDC 发行方与业务强耦合** | `src/account/oauth.ts`、`src/account/manager.ts` | 标准 PKCE 代码与 Modelflare 专有 `/api/account`、`/api/keys`、`/api/invite`、`utm_source` 混写在一起 | 拆分为纯粹的 `OidcPkceClient`（支持任意标准 OIDC Discovery 端点）+ 可选 `BillingProviderAdapter` 接口 |

## 二、分阶段 TDD 实施任务拆解

### Task 1: 多供应商注册表与预设模板引擎（`src/sugent/provider-registry.ts`）

**涉及文件：**
- 新建：`src/sugent/provider-registry.ts`
- 修改：`src/sugent/types.ts`、`src/sugent/index.ts`
- 测试：`test/sugent-provider-registry.unit.test.ts`

**设计要点：**
1. 定义标准 `LlmProviderPreset` 与 `LlmProviderConfig`：
   - 内置预设：`openai`、`anthropic`、`deepseek`、`gemini`、`openrouter`、`ollama`（默认免 Key 本地回环 `127.0.0.1:11434/v1`）、`cowork`（默认 `127.0.0.1:28080/v1`）、`custom-openai`、`modelflare-legacy`（可选兼容）。
2. 定义每个 Provider 的协议映射（`deriveProviderApiEndpoints`）：
   - Anthropic 原生协议自动识别 `/v1/messages`；
   - OpenAI Responses 协议与标准 Chat Completions 协议按预设或自定义开关声明，无需调用私有接口探测。
3. 提供纯函数校验器 `validateProviderEndpoint()`（校验协议头、脱敏展示 `keyTail`，严禁把 API Key 写入命令行参数或明文日志）与持久化存储封装（存入 `<dataDir>/sugent-providers.json`，权限 `0o600`，密钥同步注册到 `registerSecret`）。

**TDD 验证步骤：**
1. 在 `test/sugent-provider-registry.unit.test.ts` 编写用例：验证内置预设解析、自定义端点添加/删除/设为主默认、按四角色（`assessor` / `executor` / `computer_use` / `steward`）绑定不同 Provider（例如 `assessor` 走本地 Ollama 零成本守门，`executor` 走 Anthropic Claude）。
2. 运行 `npx vitest run test/sugent-provider-registry.unit.test.ts` 确认先红后绿。

### Task 2: 离线优先的模型能力目录与本地 SQLite 预算账本（`src/sugent/model-catalog.ts` & `src/sugent/local-budget.ts`）

**涉及文件：**
- 新建：`src/sugent/model-catalog.ts`
- 新建：`src/sugent/local-budget.ts`
- 修改：`src/app.ts`（`infoOf`、`ratesOf`、`setBotBudget`、`refreshBotBudgets` 回退链）
- 测试：`test/sugent-model-catalog-budget.unit.test.ts`

**设计要点：**
1. `src/sugent/model-catalog.ts`：
   - 内置常见模型家族（`claude-*`、`gpt-4.1*` / `gpt-5*` / `o3*` / `o4*`、`deepseek-*`、`gemini-*`、`qwen*`、`llama*`）的默认 `contextWindow`、`vision`、`reasoning`、`endpoints`（如 Claude 自动标记支持 `anthropic` 原生接口以保留 Prompt Caching 与 Extended Thinking！）以及参考 Token 单价 `rates`（输入/输出/缓存命中单价）。
   - 支持用户在配置中覆盖任意模型的上下文窗口或单价（本地私有化部署可设为 `0` 美元）。
2. `src/sugent/local-budget.ts`：
   - 在本地数据目录记录每个 `botId` 按自然月（或滚动周期）累计消耗的 `usedUsd` 与 `limitUsd`。
   - 当用户调用 `PUT /amb/api/bots/:id/budget` 时，直接写入本地预算配置并立即生效，彻底移除 `if (!this.session) throw new ApiError(t("account.budget_needs_login"), 409)` 限制；当剩余额度低于 20% 时复用 `TaskService` 现有的暂停后台任务逻辑。

**TDD 验证步骤：**
1. 编写单元测试验证：未登录任何云账户时，Claude 模型依然被正确识别为支持 `anthropic-messages` 接口；给任意 Bot 开启 `$10` 本地预算后，模拟记账达到 `$8.5`（剩余 `< 20%`）能准确触发后台任务保护。
2. 运行 `npx vitest run test/sugent-model-catalog-budget.unit.test.ts` 通过。

### Task 3: 解除 `MagpieSupervisor` 单服务商限制并打通多 Provider 同步

**涉及文件：**
- 修改：`src/magpie/supervisor.ts`
- 修改：`src/app.ts`
- 测试：`test/sugent-magpie-multiprovider.unit.test.ts`

**设计要点：**
1. 在 `MagpieSupervisor` 中新增通用方法：
   - `upsertGenericProvider(cfg: LlmProviderConfig)`：移除 `allowedModelflareUrls` 白名单硬拦截，支持向内置 Magpie 写入多个命名 Provider（如 `openai`、`anthropic`、`deepseek`、`ollama`），且不再附带 `X-Modelflare-Skill` 私有归因请求头。
   - `removeGenericProvider(providerId: string)` 与 `listConfiguredProviders()`。
   - 支持从 `config.json`（而不仅是环境变量）读取 `unlockSubscriptions` 布尔开关动态控制 `MAGPIE_NO_ACCOUNTS` 与 `settings.noAccountDiscovery`，切换后空闲重启 Magpie 即可生效。
2. 保留 `connectModelflare()` 作为 `upsertGenericProvider` 的薄包装层，保证现有测试套件零回归破坏。

**TDD 验证步骤：**
1. 编写单元测试（Mock `runCli` 与本地 `/api/provider/save` 端点）验证同时注册 DeepSeek + Anthropic + Ollama 三个 Provider，且请求头不含任何第三方统计头。
2. 运行 `npm run test:sugent` 验证全部通过。

### Task 4: 账户 OAuth / OIDC 协议层与业务适配器彻底剥离（`src/sugent/auth-provider.ts`）

**涉及文件：**
- 新建：`src/sugent/auth-provider.ts`
- 修改：`src/account/manager.ts`、`src/web/server.ts`
- 测试：`test/sugent-auth-provider.unit.test.ts`

**设计要点：**
1. 定义与具体厂商无关的身份认证接口 `IdentityProviderAdapter`：
   - **`NoAuthIdentityAdapter`（默认）**：`mode: "none"`，`loginAvailable: false`，完全隐藏“账户充值/邀请码/官方公告”等商业化入口，所有连接、预算与模型均由本地管理。
   - **`GenericOidcIdentityAdapter`（标准 OIDC + PKCE）**：复用 RFC 8252 回环临时端口 + S256 PKCE + `AccountVault` 系统钥匙串加密存储，支持配置任意标准 OIDC 参数（`issuer`、`clientId`、`scopes`，无任何 `utm_source` 注入）。支持两类登录后置钩子（Provisioning Hook）：
     - `token_passthrough`：直接将 OIDC Access Token（或刷新的 JWT）作为企业网关 Bearer 凭证（适用于自建 Keycloak/Dex + 企业 AI 网关）；
     - `key_exchange`：调用可配置的令牌交换端点（如 Cowork `/api/config/generate` 或企业 One-API）换取员工级 `sk-emp-*` 密钥自动注入工作 Bot。
   - **`ModelflareLegacyAdapter`（可选插件）**：仅在用户显式配置 `auth.mode === "modelflare"` 时挂载原有的余额、邀请与远程子密钥修复逻辑。
2. 同样检查 `src/agent/accounts.ts`（工作区工具连接 OAuth，如飞书、Notion）：保持工具数据授权（Settings -> Connections）与主程序身份完全独立，后续扩展 GitHub / Google Workspace OAuth 时直接实现 `AccountAuth` 联合类型即可。

**TDD 验证步骤：**
1. 用本地临时 HTTP Mock OIDC Discovery + Token Endpoint 测试 `GenericOidcIdentityAdapter`：验证 PKCE S256 校验、State 时序安全比对、无 `utm_*` 参数泄露、Refresh Token 自动续期以及退出登录时的 Token Revocation。
2. 运行 `npx vitest run test/sugent-auth-provider.unit.test.ts` 通过。

### Task 5: Web API 与前端引导页 / 设置页去品牌化重构（`/amb/api/providers` & `/amb/api/auth`）

**涉及文件：**
- 修改：`src/web/server.ts`、`src/cli/init.ts`
- 修改：`ui/screens/onboarding.js`、`ui/screens/settings.js`、`ui/screens/account.js`、`ui/lib/links.js`、`ui/locales/zh-CN/*.js`、`ui/locales/en/*.js`
- 测试：`test/sugent-providers-api.unit.test.ts`

**设计要点：**
1. 新增中立 REST 接口（保留旧 `/modelflare` 路由转发做向后兼容）：
   - `GET /amb/api/providers`：列出已配置的所有 LLM Providers（含连接状态、模型数、密钥尾号、四角色路由表、`unlockSubscriptions` 状态）；
   - `POST /amb/api/providers` / `PUT /amb/api/providers/:id` / `DELETE /amb/api/providers/:id`：增删改查任意服务商并执行一次 `GET {baseUrl}/models`（或 Anthropic 模型校验）连通性探测；
   - `GET /amb/api/auth/status`、`POST /amb/api/auth/login`、`POST /amb/api/auth/logout`：按当前 `auth.mode` 返回状态（`mode: "none"` 时前端不渲染账户登录卡片与充值/邀请入口）。
2. 重构首次启动页（`ui/screens/onboarding.js`）与终端 `npm run init`：
   - 首屏提供三张简洁卡片：**「配置 API Key（OpenAI / Anthropic / DeepSeek / 自定义）」**、**「连接本地模型或本机订阅（Ollama / Claude Code / Codex）」**、**「接入企业 Cowork / OIDC 网关」**；
   - 移除所有硬编码的 `MF_CONSOLE`、`MF_KEYS`、`utm_source=anymodelbot` 商业外链与充值提示。
3. 重构设置页（`ui/screens/settings.js`）：
   - 将原“Modelflare”标签页升级为**「模型服务商与路由（Providers & Routing）」**，支持添加多个服务商、配置 `assessor` / `executor` / `computer_use` / `steward` 四角色分层模型，以及一键切换本机 CLI 订阅发现。

**TDD 与全链路验收门禁：**
1. 运行 `npm run test:sugent` 确认全部单元与 API 测试通过。
2. 运行 `npm run verify:sugent`（`tsc --noEmit` + `npm run build` + `node scripts/verify-sugent.mjs` + `npm run docs:check`）确保零类型错误、零文档死链。
3. 在全新空 `--data-dir` 下验证：无需任何外部 OAuth 登录，仅填一个本地 Ollama 或任意 OpenAI/Anthropic 兼容端点即可完成首次引导、对话、四角色分流与机器人本地美元预算限制。

## 三、平滑迁移与零侵入防冲突策略

1. **老数据自动无损迁移**：启动时若检测到 `<dataDir>/config.json` 或内置 Magpie `providers.json` 中已有旧版 `modelflare` 连接，自动将其映射为 `sugent-providers.json` 中的一条普通 Provider 记录，用户无需重填密钥。
2. **上游同步低冲突**：核心逻辑全部收敛在 `src/sugent/provider-registry.ts`、`src/sugent/model-catalog.ts`、`src/sugent/local-budget.ts` 与 `src/sugent/auth-provider.ts` 四个独立模块中；对宿主 `src/app.ts`、`src/magpie/supervisor.ts` 和 `src/web/server.ts` 仅做薄委托挂接，保障未来运行 `npm run sync:upstreams` 时合并成本最低。
