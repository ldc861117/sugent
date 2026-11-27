# Wave P3：双微信号「前店后厂」社交幕僚网络实施方案

**Goal:** 在保持 Sugent 核心仓库与主理人主微信号 100% 官方合规零风险的前提下，打通主号合并转发秒参谋、个人站公域访客直推拍板、外置 `agent-wechat` 独立助理微信号边车耳麦代回及白名单项目群静默纪要沉淀全链路。
**Spec Reference:** `docs/ROADMAP.md` Wave P3 (`P3.2` – `P3.4`) & 第 0 节合规边车隔离门禁
**Tech Stack & Test Runner:** TypeScript ESM (`NodeNext`), Node.js >= 22 (`node:sqlite`), Vitest (`npx vitest run <file>`), `npm run verify:sugent`
**Execution Pipeline:** `subagent-orchestrator` -> `code-review` -> `verification-gate`

## Wave Summary
- **Wave 1 (Parallel Fan-Out — 3 Strictly Disjoint Tasks):**
  - **Task 1 (`P3.2`):** 主号合并转发消息展开、3 秒转发参谋落账辅助与 `OpsBridgeClient` 公域访客队列 (`publicConciergeQueue` / `conciergeDecisions`) 契约。
  - **Task 2 (`P3.3`):** 外置 `agent-wechat` (`wx serve`) Loopback HTTP 边车适配器 (`src/sugent/wechat-envoy-sidecar.ts`) 与 GCE 受限边车部署套件 (`deploy/gce-hub/compose.wechat-envoy.yml`)。
  - **Task 3 (`P3.4`):** 白名单项目群静默纪要员与五维账本候选提炼器 (`src/sugent/group-chat-scribe.ts`)。
- **Wave 2 (Sequential SDD Integration — Depends on Tasks 1, 2, 3):**
  - **Task 4:** 统一导出与宿主合龙（`src/sugent/index.ts`、`concierge-*` 受控群 `@` 代回放行、`steward-host-service.ts`、`steward-llm-agent.ts` 新增 `analyze_forwarded_chat` 与 `manage_wechat_envoy` 工具、`src/app.ts` 脉冲联动、`src/web/server.ts` 管理路由及 `scripts/verify-sugent.mjs` 第 28 节门禁）。
- **Wave 3 (Independent Review & Verification Gate):**
  - 双轴独立代码审查（Spec Alignment + Code Health）与全量 `vitest` + `npm run verify:sugent` 验收。

---

### Task 1: P3.2 主号合并转发解析、转发参谋落账与公域访客桥接契约
- **Wave:** Wave 1 (Parallel)
- **Depends on:** None
- **Touches files (Disjoint Set A):**
  - Modify: `src/channels/weixin/api.ts`
  - Modify: `src/channels/weixin/channel.ts`
  - Modify: `src/sugent/weixin-quota-and-briefing.ts`
  - Modify: `src/sugent/ops-bridge-client.ts`
  - Test: `test/sugent-p3-forwarded-and-public-envoy.unit.test.ts`

1. **Write the failing test (`test/sugent-p3-forwarded-and-public-envoy.unit.test.ts`)**:
   - 测试 `weixinParts` 解析含 `record_item` / `appmsg_item`（标题“群聊的聊天记录”、摘要描述或嵌套子条目 / XML `<recorditem><datalist><dataitem>` 节点）的 `MessageItem` 时，生成以 `[合并转发的聊天记录]` 开头的清晰文本 `Part`。
   - 测试 `ingestForwardedBriefingToLedger` 调用 `buildThreeSecondForwardedBriefing` 并在 `autoRecordToLedger: true` 时自动从转发对话中提炼承诺事项（如“周五前发你测试表” -> `waiting_for`，“我明天给你报价单” -> `i_owe`）及对手方沟通记录，且相同文本重复调用幂等不重复建待办。
   - 测试 `OpsBridgeClient.fetchFleetSnapshot()` 从 `/api/ops/bridge/steward-pending` 响应解析 `publicConciergeQueue`（含 `sessionId`, `actorLabel`, `species`, `intentSummary`, `contactEmail`, `matchedDomains`），并测试 `OpsBridgeClient.stewardSync({ conciergeDecisions })` 原样携带 `conciergeDecisions` 发送至 `/api/ops/bridge/steward-sync`。
2. **Verify RED**: `npx vitest run test/sugent-p3-forwarded-and-public-envoy.unit.test.ts` 预期因新字段/函数未实现而失败。
3. **Implement minimal code**:
   - `src/channels/weixin/api.ts`: 在 `MessageItem` 上补充可选兼容字段 `record_item?: { title?: string; desc?: string; record_xml?: string; items?: Array<{ sender_name?: string; content?: string; data_desc?: string }> }` 与 `appmsg_item?: { title?: string; desc?: string; xml?: string; record_item?: string }`。
   - `src/channels/weixin/channel.ts`: 新增导出辅助函数 `extractForwardedRecordText(it: MessageItem): string | undefined` 并在 `weixinParts` 中处理合并转发条目（含 XML `<sourcename>`/`<datadesc>` 提取与长度裁剪，剥离恶意控制标签）。
   - `src/sugent/weixin-quota-and-briefing.ts`: 新增 `IngestForwardedBriefingInput` / `IngestForwardedBriefingResult` 与 `ingestForwardedBriefingToLedger`（支持 `StewardshipLedger` 可选落账双向承诺与幂等去重指纹）。
   - `src/sugent/ops-bridge-client.ts`: 新增 `OpsPublicConciergeItem` 与 `OpsPublicConciergeDecision` 类型，扩展 `OpsStewardPendingSnapshot.publicConciergeQueue` 与 `OpsStewardSyncInput.conciergeDecisions`。
4. **Verify GREEN**: `npx vitest run test/sugent-p3-forwarded-and-public-envoy.unit.test.ts` 零失败通过。

---

### Task 2: P3.3 外置 `agent-wechat` 助理微信号 HTTP 边车适配器与 GCE 部署套件
- **Wave:** Wave 1 (Parallel)
- **Depends on:** None
- **Touches files (Disjoint Set B):**
  - Create: `src/sugent/wechat-envoy-sidecar.ts`
  - Create: `deploy/gce-hub/compose.wechat-envoy.yml`
  - Modify: `deploy/gce-hub/README.md`
  - Test: `test/sugent-wechat-envoy-sidecar.unit.test.ts`

1. **Write the failing test (`test/sugent-wechat-envoy-sidecar.unit.test.ts`)**:
   - 未配置 `baseUrl` / `enabled: false` 时 `WeChatEnvoySidecarClient` 与 `WeChatEnvoyPoller` 100% 静默零网络请求。
   - 自发防回环与主人免扰：当入站消息 `fromSelf: true` 或 `senderId === selfWxid` 时一律丢弃，绝不触发回环。
   - 访问策略门控：`dmPolicy: "allowlist"` 仅放行白名单 `wxid`；群聊消息（`chatId` 以 `@chatroom` 结尾或 `isGroup: true`）：
     - 若群不在 `allowedGroupIds` 内，直接丢弃；
     - 若群在 `allowedGroupIds` 内但**未 `@提及` 助理微信号**（`mentionedSelf === false` 且文本不含 `@<selfAlias>`），不走对外回复管线，而是分发给 `onGroupSilentMessage` 供静默纪要员消费；
     - 若群在 `allowedGroupIds` 内且明确 `@提及` 助理微信号，封入 `0o400` 安全信封（`sealExternalEvent`，剥离 `cwd`/`permission` 等越权字段）后触发 `onActionableInbound`。
   - 游标持久化与幂等去重：重启后从 `0o600` 状态文件恢复 `lastEventCursor` 与最近已处理 `messageId` 集合，不重复消费历史消息；单会话发送速率限制生效。
   - 出站 `sendMessage` 携带 `Authorization: Bearer <apiToken>` 调用边车 `POST /api/messages/send`（支持可选 `replyTo` 与 `mentions`）。
2. **Verify RED**: `npx vitest run test/sugent-wechat-envoy-sidecar.unit.test.ts`。
3. **Implement minimal code**:
   - 实现 `src/sugent/wechat-envoy-sidecar.ts`（含 `resolveWeChatEnvoyConfig`、`WeChatEnvoySidecarClient`、`WeChatEnvoyPoller`，默认绑定环回地址校验：非环回 HTTP 明文地址除非显式 `allowRemoteHttps` 且为 `https://` 否则拒绝携带 Bearer Token 外发）。
   - 创建 `deploy/gce-hub/compose.wechat-envoy.yml`（镜像 `ghcr.io/thisnick/agent-wechat-native:latest`，`mem_limit: 384m`，`memswap_limit: 512m`，仅监听 `127.0.0.1:6174:6174`，`cap_drop: [ALL]`，`security_opt: [no-new-privileges:true]`，持久化数据卷与受限缓存卷），并在 `deploy/gce-hub/README.md` 增补第 5 节「双微信号前店后厂边车挂载与新号养号规范」。
4. **Verify GREEN**: `npx vitest run test/sugent-wechat-envoy-sidecar.unit.test.ts` 零失败通过。

---

### Task 3: P3.4 白名单项目群静默纪要员（`GroupChatScribe`）与五维账本沉淀
- **Wave:** Wave 1 (Parallel)
- **Depends on:** None
- **Touches files (Disjoint Set C):**
  - Create: `src/sugent/group-chat-scribe.ts`
  - Test: `test/sugent-group-chat-scribe.unit.test.ts`

1. **Write the failing test (`test/sugent-group-chat-scribe.unit.test.ts`)**:
   - 非白名单群聊消息被拒绝（`ignored_unlisted_group`），白名单群聊消息静默写入滚动缓冲（单群上限 200 条，`0o600` 原子落盘，自动脱敏密钥与本地路径），且 `outboundGroupRepliesCount` 恒等于 `0`。
   - `distillGroupDigest(groupId)` 从缓冲对话中确定性提取三类候选并支持可选异步 `llmExtractor` 增强：
     1. 对方承诺（如 `王总: 我周五下班前把二期接口文档发群里` -> `direction: "waiting_for"`, `counterparty: "王总"`）；
     2. 我方待办（如 `李工: 麻烦刘总团队周三前确认一下字段映射表` -> `direction: "i_owe"`）；
     3. 干系人沟通忌讳/偏好（如 `张经理: 汇报材料千万别放未脱敏工单截图` -> `kind: "taboo_or_preference"`）。
   - 生成待主理人拍板的 `GroupScribeDigestCard`（`status: "pending_approval"`）；在主理人调用 `approveDigest(digestId)` 之前，`StewardshipLedger` 零写入；调用 `approveDigest(digestId)` 后，正式写入 `StewardshipLedger`（`work_project` 分区）且重复调用幂等，调用 `dismissDigest(digestId)` 则标记忽略不落账。
2. **Verify RED**: `npx vitest run test/sugent-group-chat-scribe.unit.test.ts`。
3. **Implement minimal code**:
   - 创建 `src/sugent/group-chat-scribe.ts` 实现 `GroupChatScribe`、滚动脱敏缓存、正则+可选模型双引擎提炼、待审纪要卡片状态机与 `StewardshipLedger` 安全落账接口。
4. **Verify GREEN**: `npx vitest run test/sugent-group-chat-scribe.unit.test.ts` 零失败通过。

---

### Task 4: Wave 2 宿主全量合龙、幕僚工具挂载与第 28 节门禁验收
- **Wave:** Wave 2 (Sequential)
- **Depends on:** Task 1, Task 2, Task 3
- **Touches files:**
  - Modify: `src/sugent/index.ts`
  - Modify: `src/sugent/concierge-guardrails.ts`
  - Modify: `src/sugent/concierge-dispatcher.ts`
  - Modify: `src/sugent/concierge-channel-bridge.ts`
  - Modify: `src/sugent/opc-concierge.ts`
  - Modify: `src/sugent/steward-host-service.ts`
  - Modify: `src/sugent/steward-llm-agent.ts`
  - Modify: `src/app.ts`
  - Modify: `src/web/server.ts`
  - Modify: `deploy/gce-hub/.env.example`
  - Modify: `scripts/verify-sugent.mjs`
  - Modify: `docs/ROADMAP.md` & `STATUS.md`
  - Test: `test/sugent-p3-integration.unit.test.ts`

1. **Write the failing integration test (`test/sugent-p3-integration.unit.test.ts`)**:
   - 验证 `StewardLlmAgent` 工具 `analyze_forwarded_chat` 与 `manage_wechat_envoy` 端到端闭环；
   - 验证助理微信号入站私聊 & 白名单群 `@提及` -> 主号微信耳麦通知 -> 主理人拍板 -> 15s 冷静期后经 `WeChatEnvoySidecarClient` 原路代回（同时保持普通群非授权情况下的 `G2_GROUP_SILENCE_LOCK` 100% 不退化）；
   - 验证公域 `publicConciergeQueue` 入站推送主号与拍板回传 `conciergeDecisions`。
2. **Implement integration & Section 28 contract gate in `scripts/verify-sugent.mjs`**.
3. **Verify GREEN**: 全量 Vitest + `npm run verify:sugent` + `npm run docs:check` 全绿。
