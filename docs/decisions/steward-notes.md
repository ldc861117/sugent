# Sugent 架构取舍与避坑备忘 (`steward-notes.md`)

## 2026-11-24 · GCE 常驻中枢、微信单持有者守卫与 `/ops` 舰队桥接

1. **微信 iLink 单持有者铁律（防双节点抢消费丢消息）**：
   - 腾讯开源 iLink 协议 `ilink/bot/getupdates` 长轮询在两个进程同时消费同一 `botToken` 时会发生消息争抢丢失。
   - 取舍：不侵入 `src/channels/weixin/` 底层实现，在 `src/sugent/ops-bridge-client.ts` 提供 `evaluateWeixinSingleHolderGuard(env)` 并在 `src/app.ts` 的 `startBot`、`startWeixinLogin`、`channelStatus` 薄层挂载。单机离线模式（未设 `OPS_BASE_URL` 且未设 `SUGENT_WEIXIN_OWNER_NODE`）100% 放行；一旦进入多节点舰队模式，默认仅允许 `gce-hub` 持有微信长轮询与扫码，`local-mac` 自动置为只读提示。
2. **Docker 桥接网络与宿主机环回端口绑定避坑**：
   - 在 `deploy/gce-hub/compose.yml` 中，若将容器内 `AMB_UI_HOST` 设为 `127.0.0.1`，Docker 默认 bridge 网络无法把宿主机 `127.0.0.1:3600:3600` 流量转发进容器内部环回口。
   - 正确做法：宿主机端口映射严格锁定 `"127.0.0.1:3600:3600"`（公网网卡零监听，仅允许 `ssh -L 3600:127.0.0.1:3600` 访问），容器内部保持 `AMB_UI_HOST=0.0.0.0`，同时兼顾零公网暴露与开箱即用转发；容器内存硬限设为 `1536m` 以保障同机 `airtoken-micro` (`e2-medium` 4 GB) 上的远程开发余量。
3. **`mode: "none"` 离线主权与高风险二次确认门禁**：
   - 未配置 `OPS_BASE_URL` 或 `OPS_NODE_TOKEN` 时，`OpsBridgeClient` 保持零网络请求静默退出，单机 BYOK 闭环不受任何云端状态影响。
   - 微信私聊支持 `/ok <id>` 与 `同意` 快速放行一般排期派单，但凡标题或摘要命中资金、合同、对外发言等高风险关键词，强制置 `requiresDashboardConfirm: true` 并拦截微信直接放行，要求前往 `/ops` Web 看板二次确认。

## 2026-11-24 · Wave P1：零表单冷启动、ACP v1 多 CLI 契约、隐式 Git 检查点与零弹窗守卫

1. **ACP v1 (`protocolVersion: 1`) 严格 `\n` 帧分界与 CLI 安全旗标红线**：
   - 官方 Agent Client Protocol v1 采用 UTF-8 换行符（`0x0A` LF）分界的 JSON-RPC 2.0 stdio 流，不能按 LSP `Content-Length` 解析，也不能用包含 Unicode `U+2028`/`U+2029` 的宽泛正则切行（否则会截断字符串字面量）。发包侧将 `\u2028`/`\u2029` 转义，收包侧仅以 `indexOf("\n")` 拆帧。
   - 适配 `claude_code` (`@agentclientprotocol/claude-agent-acp`)、`codex` (`@agentclientprotocol/codex-acp` + `INITIAL_AGENT_MODE=workspace-write|read-only`)、`opencode` (`opencode acp --cwd`) 与 `pi` (`pi-acp`) 时，硬编码拦截 `--dangerously-skip-permissions`、`danger-full-access` 与已废弃的 `--full-auto`。
2. **零脏树隐式 Git 检查点（独立 `GIT_INDEX_FILE` + `refs/sugent/checkpoints/*`）**：
   - 传统 `git stash` 或工作区直接 `git add` 会污染用户当前暂存区与分支历史。`GitRefCheckpointManager` 通过临时目录中的独立 `GIT_INDEX_FILE` 执行 `read-tree` -> `add -A` -> 剥离 `.sugent-handoff`/`.worktrees` -> `write-tree` -> `commit-tree` -> `update-ref refs/sugent/checkpoints/<pipelineId>/<roundId>`，全程不触碰 `.git/index` 与 `HEAD`，并在 `restoreCheckpoint` 前自动生成 `pre-restore-*` 兜底快照且在临时索引中剔除受保护目录。
3. **Worktree APFS CoW 零膨胀与 macOS TCC 零启动弹窗**：
   - `GitWorktreeManager.prepareWorktree` 在 macOS 优先执行 `cp -c -R`（APFS `clonefile` 写时复制，秒级零额外磁盘块且隔离后续写入），跨卷或非 APFS 自动退回符号链接（Windows 退回目录 `junction`），并按槽位分配无碰撞三端口组（`PORT`/`VITE_PORT`/`SUGENT_PREVIEW_PORT`）与 `0o700` 独立 `.sugent-tmp`。
   - `LazyDesktopPermissionGate.onAppBoot()` 严格保持 `bootChecksTriggered === 0`，彻底消除首次打开应用时的屏幕录制/辅助功能连环弹窗，仅在真正触发桌面 CUA 动作时按需探测并返回引导卡。

## 2026-11-25 · 第三方网关保存回读 `omitempty` 误报与模态框玻璃滤镜下拉漂移

1. **Magpie Go `omitempty` 导致的首次保存误报「保存后校验失败」**：
   - `App.upsertDecoupledProvider` 先将服务商落盘至 `sugent-providers.json`，随后调用 `MagpieSupervisor.upsertGenericProvider` 写入 `{ chat, responses, anthropic: "", ... }`。Magpie Go 侧 `Provider` 结构体对空字符串使用了 `json:"...,omitempty"`，回读 `providers.json` 时 `saved.anthropic` 为 `undefined`。旧逻辑 `JSON.stringify(saved?.[k] ?? {}) !== JSON.stringify(v ?? {})` 将 `undefined ?? {}` 算成 `"{}"` 与 `'""'` 对比必败，导致已成功落盘却向前端抛错。通过 `matchesMagpieSavedField` 统一归一化空串/空对象/空数组与尾部斜杠彻底根除。
2. **`.sheet` 模态框 `backdrop-filter` 劫持 `position: fixed` 导致下拉框漂移与被裁切**：
   - CSS 规范中祖先节点含 `backdrop-filter` 会创建新的 `position: fixed` 包含块，导致内联渲染在 `.sheet` 内部的 `.pop` 把 `getBoundingClientRect()` 视口坐标叠加在模态框左上角偏移上，同时被 `.sheet { overflow: auto }` 截断右边缘。改为将 `Popover` 直接挂载至 `document.body`（层级设为 `calc(var(--z-modal) + 4)`）并监听捕获阶段滚动与 `Escape` 分级关闭。

## 2026-11-25 · Wave P2：合盖离线零知识摘要舱、微信 3 秒合规参谋与标杆武器包收官

1. **防休眠电池上限与零知识双 Schema 防混淆（`P2.1`）**：
   - `PowerSaveBlockerController` 强制默认 8 小时电池保护封顶，且切换模式时先 `stop` 旧句柄防止 Electron `powerSaveBlocker` 句柄泄漏。
   - `E2eeOfflineDigestVault` 复用 `e2ee-sync.ts` 的 `config-snapshot` HKDF 通道，但通过内层 `sugent.offline_ledger_digest.v1` 与 `sugent.offline_queued_task.v1` 严格防跨类型重放，并在生成云端只读摘要时物理剥离 `localUriOrPath` 与敏感 `metadata`；唤醒排空采用「全量预解密校验 → Lamport 时钟升序 → `0o600` 原子去重落账」，避免半途解密失败污染账本。
2. **微信 iLink 合规边界、低配额折叠与中文金额词边界避坑（`P2.2`）**：
   - 严守 `COMPLIANCE_MODE = "forwarded_or_screenshot_only"`，不触碰个人微信原生聊天窗内存/数据库；转发文本先经 `sealExternalEvent` (`privilegedFieldMode: "strip"`) 剥离越权字段并隔离存储，再对照五维账本召回底价、账期与沟通禁忌，且生成的两版外发话术严禁回显内部禁忌原文。
   - 正则提取中文金额（如 `"14 万？"`）时，JavaScript 非 `/u` 正则将中文字符与全角标点均视为 `\W`，若写成 `(?:万|万元|w)\b` 会因两个 `\W` 之间不存在 `\b` 导致漏匹配；必须写成 `(?:万元|万|w\b)` 仅对 ASCII `w` 施加词边界。
3. **端-边联邦武器包确定性门禁与否定保护条款消歧（`P2.3`）**：
   - 工业现场 FDE 诊断包（`industrial-fde-diagnostics`）与一人公司合同防漏包（`opc-contract-quote-guard`）均以安全信封包裹外部不可信批次/合同文本，所有产出强制进入 `PENDING_REVIEW` 或主理人拍板卡（`requiresHumanStagingGate: true`）。
   - 合同红线扫描通过前向窗口否定词检测（`不承担/不涉及/免除/排除`）区分保护性免责条款（如“乙方不承担无限连带责任”放行）与真实毒丸条款（拦截），并由 `WeaponSoakTelemetryLedger` 执行 14 天常驻与越权事故一票否决计量。

## 2026-11-25 · 云端唯一主权大脑、全渠道跨天记忆与边缘编码触手架构

1. **「服务端唯一大脑 + 全端零折损触手」产品哲学对齐**：
   - 将 Sugent 明确收敛为常驻云端的唯一顶层管家与总协调者（不把状态锁死在某台笔记本客户端上，也不让顶层管家越俎代庖硬写业务代码）。微信与 HTTPS Web 工作台连接同一颗云端大脑，共享 100% 对等记忆与全局态势；具体编码开发任务通过 `dispatch_edge_antigravity` 下发至本机 `local-mac` 或云端 `gce-remote` 的轻量 `edge:tentacle` 守护代调 Antigravity 落地，完工后幂等回执并推送微信通知。
2. **自然语言跨天时间浏览查询防误杀与容器冷启动回填**：
   - 此前微信端回答“日常对话不会跨天存留”，根因在于：(a) 容器重启后 `OwnerChannelStewardRouter` 内存滑窗清零；(b) `StewardLlmAgent` 缺少历史对话检索工具。`ChatTranscriptRecallService` 在不改动上游 `anymodel.db` 表结构的前提下合并 SQLite 历史消息与 `0o600` `steward-web-turns.jsonl`，对“昨天我们聊了什么”（含拼音误触“昨天我没聊了什么”）自动剥离时间/元提问词并聚焦昨日时间窗，避免拿“昨天”做字面子串过滤导致零命中。
3. **反向代理鉴权安全细节（`Secure` Cookie + `no-referrer` + 最小权限边缘令牌）**：
   - 经 HTTPS 反向代理首次通过 `/?token=<ui-token>` 换取长效 `amb_token` Cookie 时，根据 `X-Forwarded-Proto: https` 自动追加 `; Secure` 与 `Referrer-Policy: no-referrer` 响应头，杜绝令牌经 `Referer` 外泄；`SUGENT_EDGE_TOKEN` 采用 SHA-256 摘要 `crypto.timingSafeEqual` 恒定时间比对，且仅放行 `/amb/api/steward/edge/*` 路由，与浏览器全权管理令牌严格隔离。


## 2026-11-26 · Wave P3：原生无头 Rust 边车选型、双微信号物理隔离与群静默纪要不变量

1. **淘汰 Xvfb 桌面容器，采用原生无头 Rust 边车（`P3.3`）**：
   - 旧版 `@agent-wechat/wechat` 依赖 Xvfb 虚拟桌面常驻消耗 700 MiB–1.1 GiB 内存，与同机 `airtoken-micro`（3.8 GiB RAM）冲突。改用 `thisnick/agent-wechat` 原生无头守护 `wx serve`（`deploy/gce-hub/compose.wechat-envoy.yml`，硬限 `mem_limit: 384m`、`cap_drop: ALL`），主号继续走腾讯官方 `iLink` 担任零封号风险后台耳麦，新手机号注册的独立助理号经 Loopback/内网 HTTP 边车接入，核心仓保持 `SUGENT_WECHAT_ENVOY_ENABLED=false` 默认静默。
2. **公私域隔离与群静默不变量（`P3.3` / `P3.4`）**：
   - 助理号所有入站与白名单群 `@提及` 强制经 `0o400` 只读安全信封隔离且零权限读取 `owner_private`；`GroupChatScribe` 硬编码 `outboundGroupMessagesSent === 0`，非 `@` 群消息绝不外发，脱敏后生成待审纪要卡经 `/gdig ok <id>` 拍板落账。

## 2026-11-27 · 人机混合项目规划、跨语言同构指纹与早报唤醒时序铁律

1. **复用 `STATUS.md` 签批闸门而非新建 `TODOS.md`**：
   - 单文件真相源避免 Gemini App 与 Antigravity 多文件写冲突；通过 `[AI]` / `[我]` / `[我·N天后|YYYY-MM-DD]` / `[等外部]` / `[观察窗·N天]` 前缀区分责任主体，只有用户在 `/ops` 点确认或口头确认状态后才幂等派生现实待办。
2. **跨语言同构 FNV-1a 指纹与相对天数一次性折算**：
   - `Andy-web/src/shared/opsSchema.js` 被浏览器 Vite 与 Node 共享，严禁引入 `node:crypto`。Python（`status_md.py`）与 JS 统一使用 UTF-8 32 位 FNV-1a 8 位十六进制摘要生成 `todo:<projectKey>:<hash8>`；`[我·5-7天后]` 基于 `statusCard.updatedAt`（或本地当前日期）一次性折算下界 `YYYY-MM-DD`，防止重扫漂移。
3. **早报唤醒时序与 `snoozed` 提前核销**：
   - `StewardHostService.runScheduledPulse` 必须严格保持 **「`unsnoozeDueCommitments` → `drainMorning` → `drainFlowBoundary` → `scanCadence` → 再将刚解冻唤醒的候选合并进 `morningDrain.emitNow`」**；若把 `scanCadence` 提前到 `drainMorning` 之前，会把夜间 `morningDigestQueue` 提前消费滤除。
   - `StewardLlmAgent` 的 `complete_todo` 工具必须覆盖 `snoozed` 状态的待办，并通过 `mutateCommitment` 同步回传 `commitmentUpdates` 至 `/ops`。

## 2026-11-27 · `agent-wechat-native` `/v1` 真实契约对齐、标签限定自动升级与人机边界铁律

1. **对齐 `agent-wechat-native` `/v1` 真实契约与共享容器环回命名空间**：
   - `WeChatEnvoySidecarClient` 原生支持 `GET /v1/status`（校验 `serverId` 并在服务端重建时安全重置过期游标）、`GET /v1/events/stream?after=<cursor>`（SSE 帧解析 + `GET /v1/messages/{id}` 补全 + `origin === "live"` 6 分钟实时窗过滤与撤回丢弃）以及 `POST /v1/accounts/{accountId}/sends`（附 `Idempotency-Key` 并在超时/5xx 时经 `by-idempotency-key` 单次核查回执而不盲目重发）。
   - `compose.wechat-envoy.yml` 改为 `network_mode: "service:sugent-hub"`，使 `wx serve` 严守 `127.0.0.1:6174` 环回限制的同时与 `sugent-gce-hub` 零桥接直通。
2. **标签限定镜像自动更新（零干扰同机 `airtoken`）与微信主动配额守卫接线**：
   - `compose.yml` 新增 `64m` `sugent-updater`（强制 `WATCHTOWER_LABEL_ENABLE=true` 仅升级带标签的 `sugent-gce-hub` 并自动清理悬空旧镜像），推 `main` 后云端 5 分钟内自动换新；`App.pushToOwner` 正式接入 `WeixinAdaptiveQuotaGuard`，低水位缓冲合并常规通知，耗尽平滑转飞书。
3. **人机职责边界硬约束**：
   - 严禁在 `STATUS.md` / `ROADMAP.md` 中将推代码、拉镜像、改配置等数字环境工作标记为 `[我]`；`[我]` 仅限实体卡实名、真机摄像头扫码与资金/承诺最终拍板，且每条待办必须保持单一原子动作。

## 2026-11-27 · 双人关系幕僚与记忆晶化引擎（`DuoStewardCrystallizer`）物理隔离与双保险联邦

1. **公私域绝对物理隔离（零 `owner_private` 串味泄露）**：
   - 双人关系试点（`bigfive-duo-site` Andy & Gillna）严禁直接读写主理人个人的 `StewardshipLedger`（含商业底价、合同与工作记录）。`DuoStewardCrystallizer` 将各 `spaceId` 独立落盘于 `<dataDir>/duo-spaces/<safeSpaceId>/`（`0o700` 目录 + 独立 `SugentKnowledgeGraph`），且 `SUGENT_DUO_BRIDGE_TOKEN` 经 SHA-256 `timingSafeEqual` 校验仅放行 `/amb/api/steward/duo/*`，请求 `/amb/api/steward/workbench` 一律返回 `401`。
2. **时效排他晶化（不翻旧账）与联邦同构双保险**：
   - 关系星晶通过 `topicKey` 绑定语义议题：当新阶段星晶经双方共鸣确认或满 3 次印证晋升为 `crystallized` 时，自动将同 `topicKey` 旧星晶置为 `superseded`（图谱侧写入 `exclusive: true`），提示词构建器强制过滤 `superseded` 与 `archived` 节点，杜绝反复翻炒已化解摩擦。
   - `bigfive-duo-site` 采用「优先调用 `SUGENT_DUO_HUB_URL` 中枢 + 异常/未配时无缝降级站内同构晶化内核」双保险架构，兼顾统一幕僚大脑演进与 Cloud Run 独立高可用。

## 2026-11-28 · 记忆全景十大断点审计、硅基个体认知核与五维立体图谱（Wave P4 架构定标）

1. **为什么「完全切脑隔离」会制造人格分裂，必须升级为「半透认知膜（Semi-Permeable Cognitive Membrane）」**：
   - 旧方案将 `duo-spaces/<spaceId>/` 与 `StewardshipLedger` / 核心 `SugentKnowledgeGraph` 物理零连接，导致双重割裂：(a) 主理人连续熬夜救火时，双人关系幕僚完全感知不到其现实精力带宽枯竭，只能背诵静态人格套话；(b) 伴侣双方共同点亮“周五晚不谈工作”微约定后，核心幕僚在微信私聊里毫无感知并继续帮主理人排加班任务。同时 `bigfive-duo-site` 流式对话仍直连 Gemini 未走 `/duo/converse`，且伴侣 `W` 缺少对称的私密口袋。
   - 正解：以 **`PartnerWeatherCapsule`（仅透传枚举级精力负荷与恢复偏好，零项目/金额/原文词元）** + **双方对称加密私密口袋（`pocket:M_private` / `pocket:W_private`）** + **共认星晶/微约定只读回链至 `owner_life`** 替代机械空气隔离。
2. **硅基个体连续性：`SiliconIdentityCore` + `EpistemicDigestionLoop` 避坑边界**：
   - 既要废除 `src/agent/steward.ts:107` 禁止记助手自身回答的自宫条款，又要严守 `2026-11-21` 确立的防膨胀红线（绝不引入 `BioCore` 拟人激素或无确认热改特质向量）。所有助手判断与人际调频经验均先以 `digested_state` 入沙盒，经现实印证或确认后才晋升 `crystallized_wisdom`。
3. **本轮源码审计暴露的十大工程断流（Wave P4.1 优先止血）**：
   - `BotRuntime` P0.1 拦截微信/飞书主理人私聊后提前 `return` 导致绕过 `scheduleReview()`；`decideSkillCandidate` 写向孤岛 `<dataDir>/skills` 且 `skillName`/YAML 未转义被 DSH 静默拒载；`MemoryGardener` 返回的修剪/降级/品味更新全部丢弃未落盘；`SugentSIMStore` 运行时 0 调用；`SugentKnowledgeGraph.removeEdge` 不归档节点导致旧事实诈尸且 `query === ""` 绕过 `maxNodes`；`ConciergeChannelBridge` 查找不存在的 `peer:` 标签且全图变金丝雀；`p2-host-service.ts` E2EE 同步丢失 `skillGateStatus` 与 `edge.source` 且漏同步 `ledger.json`。

