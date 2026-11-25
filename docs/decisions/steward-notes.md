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
