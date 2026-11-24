# Sugent Wave P0（第一阶段：内核止血、双脑归一与主循环合龙）Implementation Plan

**Goal:** 在零新增领域概念与严守上游零侵入边界的前提下，于 2 周内消除 `BotRuntime/DSH` 与 `StewardLlmAgent` 的双大脑平行宇宙撕裂，将防注入安全信封、主动伴行脉搏、Vibe 因果账本与技能结晶沙盒门禁 100% 合龙进 `src/app.ts` 宿主主循环，并在 UI 默认收敛多 Bot 与历史计费冗余包袱。
**Spec Reference:** [`docs/ROADMAP.md`](../ROADMAP.md) Wave P0（`P0.1`、`P0.2`、`P0.3`）及 [`research/2026-11-23-t3code-landscape-and-sugent-critical-review.md`](../../research/2026-11-23-t3code-landscape-and-sugent-critical-review.md) 第四章结构性病灶审计。
**Tech Stack & Test Runner:** TypeScript 7.0 (ESM `NodeNext`), Node.js >= 22.13, Preact 11 + `htm` (`ui/`), Vitest 5 (`npx vitest run <file> < /dev/null`, `npm run test:sugent < /dev/null`, `npm run verify:sugent < /dev/null`).
**Execution Pipeline:** `subagent-orchestrator` -> `code-review` -> `verification-gate`

---

## Pre-Plan Commercial Reflection Gate（AGENTS.md 商业策略自省四问）

遵循 [`AGENTS.md`](../../AGENTS.md) 第 3.3 节强制门禁，开工前逐项核验如下：

| 自省维度 | 核心拷问 | 本方案的落位与守线措施 |
| :--- | :--- | :--- |
| **1. 付费锚点（Why Pay & Moat）** | 哪些属开源引流，哪些构成商业溢价？对比 T3 Code 与大厂套件优势在哪？ | 把微信与飞书主理人私聊直连唯一幕僚大脑（五维账本 + 经验自适应选模 + Vibe 派单）作为核心基座能力合龙，直接兑现相比纯桌面编码控制面（T3 Code / Paseo）的“随身零看护税参谋”代差体验，为 Pro/Team 版跨端 E2EE 记忆同步与外出移动审批中继夯实留存基础。 |
| **2. 合规与分发（Distribution & ToS Risk）** | 能否顺利通过 macOS 公证、Windows 签名与企业安全审计？ | 纯 TypeScript 宿主接线与本地文件隔离，零新增原生或第三方 npm 依赖、零客户端硬编码密钥，不改动只读签名外壳 `app.asar`，微信与飞书通道保持在既有官方 SDK / iLink 合规接口边界内。 |
| **3. 离线退路（Sovereignty Fallback）** | 剥离云端账号进入 `mode: "none"` 后，核心闭环能否独立运转？ | 在 `mode: "none"` 免登录单机 BYOK / 本地 Ollama 模式下，跨渠道唯一幕僚路由、规则安全信封、早报与园丁守护定时器、因果溯源及技能沙盒确认 100% 本地闭环可用。 |
| **4. 一人公司运维杠杆（OPC Ops Leverage）** | 是否符合“无状态边缘服务 + 端侧重逻辑”，降低日常维护负担？ | 严格执行“零新概念、先做减法”：不新增任何云端组件，统一分裂的因果账本路径，折叠界面遗留多 Bot 与旧计费线路噪音，减少状态分叉与日常排障成本。 |

---

## Wave Summary

- **Wave 1 (Parallel — 4 组完全不相交文件集，可由 `subagent-orchestrator` 并行派发 4 个独立实现子代理)：**
  - **Task 1 (`P0.2c` 因果账本路径归一与 Vibe 全链路溯源)**：`src/sugent/causal-ledger.ts`, `src/cli/why.ts`, `src/sugent/vibe-coding-pipeline.ts`, `test/sugent-vibe-pipeline.unit.test.ts`
  - **Task 2 (`P0.3b` 技能结晶沙盒门禁与缓存上限保护)**：`src/sugent/knowledge-graph.ts`, `src/agent/manager.ts`, `test/sugent-kg.unit.test.ts`
  - **Task 3 (`P0.1a` 微信/飞书主理人唯一幕僚桥与重任务下沉接口)**：`src/sugent/owner-channel-steward-router.ts`, `src/sugent/steward-llm-agent.ts`, `test/sugent-owner-channel-router.unit.test.ts`
  - **Task 4 (`P0.3a` 前台 One-Jarvis 极简默认态与多 Bot 历史包袱折叠)**：`ui/screens/sidebar.js`, `ui/screens/settings.js`, `ui/locales/zh-CN/steward.js`, `ui/locales/en/steward.js`, `test/sugent-one-jarvis-ui.unit.test.ts`
- **Wave 2 (Sequential, depends on Wave 1 — 宿主公共接缝合龙)：**
  - **Task 5 (`P0.1b + P0.2a + P0.2b` 宿主 `App` 安全信封、节律守护脉搏与 `BotRuntime` 薄钩子接线)**：`src/sugent/index.ts`, `src/sugent/steward-host-service.ts`, `src/core/runtime.ts`, `src/app.ts`, `src/web/server.ts`, `test/sugent-p0-host-loop-closure.e2e.unit.test.ts`
- **Wave 3 (Sequential, depends on Wave 2 — 门禁注册与全量实证验收)：**
  - **Task 6 (`P0 Gate` 测试集注册、`verify-sugent.mjs` 第 23 节契约断言与全量验收)**：`package.json`, `scripts/verify-sugent.mjs`

---

### Task 1: 统一 `CausalLedger` 存储路径并补齐 Vibe Coding 全阶段溯源（P0.2c）
- **Wave:** Wave 1 (Parallel)
- **Depends on:** None
- **Touches files:**
  - Modify: `src/sugent/causal-ledger.ts`
  - Modify: `src/cli/why.ts`
  - Modify: `src/sugent/vibe-coding-pipeline.ts`
  - Test: `test/sugent-vibe-pipeline.unit.test.ts`

1. **Write the failing test**: 在 `test/sugent-vibe-pipeline.unit.test.ts` 末尾追加用例：
   ```ts
   it("records full Vibe pipeline lifecycle into unified CausalLedger for sugent:why", async () => {
     const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-vibe-why-"));
     try {
       const ledgerDir = resolveUnifiedCausalLedgerDir(tmp);
       expect(ledgerDir).toBe(path.join(tmp, "sugent-stewardship"));
       const causalLedger = new CausalLedger(ledgerDir);
       // 使用既有 mock harness 初始化 VibeCodingPipelineOrchestrator({ ..., causalLedger })
       // 依次执行 startTask -> decideTask(approve plan) -> runVerificationAndPackage
       const trace = causalLedger.explainWhy(started.pipeline.pipelineId);
       expect(trace?.facts.map((f) => f.kind)).toEqual(
         expect.arrayContaining(["round_triggered", "approval_requested", "approval_decided", "round_completed"]),
       );
     } finally {
       fs.rmSync(tmp, { recursive: true, force: true });
     }
   });
   ```
2. **Verify RED**: 运行 `npx vitest run test/sugent-vibe-pipeline.unit.test.ts -t "unified CausalLedger" < /dev/null`，预期失败原因为 `resolveUnifiedCausalLedgerDir is not a function` 且 `vibe-coding-pipeline.ts` 未调用 `causalLedger.append`。
3. **Implement minimal code**:
   - 在 `src/sugent/causal-ledger.ts` 新增 `export function resolveUnifiedCausalLedgerDir(dataDir: string): string`，返回 `path.join(path.resolve(dataDir), "sugent-stewardship")`；若新目录尚无 `causal-ledger.jsonl` 而旧目录 `<dataDir>/sugent-ledger/causal-ledger.jsonl` 存在，构造器自动只读导入历史记录保证零丢账。
   - 在 `src/cli/why.ts` 将默认路径切换为 `resolveUnifiedCausalLedgerDir(dataDir)`。
   - 在 `src/sugent/vibe-coding-pipeline.ts` 的 `startTask`、`decideTask` 与 `runVerificationAndPackage` 关键状态跃迁处调用 `this.opts.causalLedger?.append(...)`，记录 `roundId: pipelineId` 的触发渠道、挂起拍板、审批结果及门禁最终 `outcome`（`"done" | "failed" | "stopped"`）。
4. **Verify GREEN**: 运行 `npx vitest run test/sugent-vibe-pipeline.unit.test.ts test/sugent-causal-ledger.unit.test.ts < /dev/null`，确认 `0` 失败。
5. **Commit boundary**: `git add src/sugent/causal-ledger.ts src/cli/why.ts src/sugent/vibe-coding-pipeline.ts test/sugent-vibe-pipeline.unit.test.ts && git commit -m "feat(p0): unify CausalLedger path and wire VibeCodingPipeline lifecycle trace"`

---

### Task 2: 收紧技能结晶沙盒门禁与单实例激活上限（P0.3b）
- **Wave:** Wave 1 (Parallel)
- **Depends on:** None
- **Touches files:**
  - Modify: `src/sugent/knowledge-graph.ts`
  - Modify: `src/agent/manager.ts`
  - Test: `test/sugent-kg.unit.test.ts`

1. **Write the failing test**: 在 `test/sugent-kg.unit.test.ts` 追加用例：
   ```ts
   it("stages workflow candidates in gated mode until approved and enforces maxActiveSkills cap", () => {
     const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-kg-gate-"));
     try {
       const kg = new SugentKnowledgeGraph(path.join(tmp, "kg"));
       const skillsDir = path.join(tmp, "skills");
       for (let i = 1; i <= 14; i++) {
         kg.applyDelta({
           nodes: [{ id: `wf:deploy-${i}`, kind: "workflow", name: `Deploy Flow ${i}`, summary: `flow ${i}`, reinforcements: 3 + i, steps: ["npm run build", "npm test"] }],
           edges: [],
         });
       }
       const beforeApproval = kg.crystallizeSkillsToDir(skillsDir, { gated: true, maxActiveSkills: 12 });
       expect(beforeApproval).toHaveLength(0);
       expect(kg.listSkillCandidates()).toHaveLength(14);

       for (let i = 1; i <= 14; i++) expect(kg.approveSkillCandidate(`wf:deploy-${i}`)).toBe(true);
       const afterApproval = kg.crystallizeSkillsToDir(skillsDir, { gated: true, maxActiveSkills: 12 });
       expect(afterApproval).toHaveLength(12);
       expect(fs.readdirSync(skillsDir)).toHaveLength(12);
     } finally {
       fs.rmSync(tmp, { recursive: true, force: true });
     }
   });
   ```
2. **Verify RED**: 运行 `npx vitest run test/sugent-kg.unit.test.ts -t "stages workflow candidates" < /dev/null`，预期因 `listSkillCandidates` / `approveSkillCandidate` 未定义且 `crystallizeSkillsToDir` 不支持 `gated` 参数而失败。
3. **Implement minimal code**:
   - 在 `src/sugent/knowledge-graph.ts` 的 `KGNode` 增加可选字段 `skillGateStatus?: "candidate" | "approved" | "rejected"`；保持无 `gated` 参数时的既有默认行为 100% 不变（兼容 `verify-sugent.mjs` 既有断言）；实现 `listSkillCandidates(threshold = 3)`、`approveSkillCandidate(nodeId: string): boolean`、`rejectSkillCandidate(nodeId: string): boolean`；当 `crystallizeSkillsToDir(skillsRootDir, { gated: true, maxActiveSkills = 12 })` 执行时，自动将未标记状态的达标节点置为 `"candidate"`，仅将 `"approved"` 节点按 `(reinforcements, updatedAt)` 降序取前 `maxActiveSkills` 个落盘并淘汰超限旧技能目录。
   - 在 `src/agent/manager.ts` 的 `review()` 后台结晶调用处传入 `{ gated: true, maxActiveSkills: 12 }`。
4. **Verify GREEN**: 运行 `npx vitest run test/sugent-kg.unit.test.ts < /dev/null`，确认全部用例 `0` 失败。
5. **Commit boundary**: `git add src/sugent/knowledge-graph.ts src/agent/manager.ts test/sugent-kg.unit.test.ts && git commit -m "feat(p0): gate skill crystallization behind owner confirmation and enforce active cap"`

---

### Task 3: 微信/飞书主理人唯一幕僚桥与重任务下沉委托端口（P0.1a）
- **Wave:** Wave 1 (Parallel)
- **Depends on:** None
- **Touches files:**
  - Create: `src/sugent/owner-channel-steward-router.ts`
  - Modify: `src/sugent/steward-llm-agent.ts`
  - Test: `test/sugent-owner-channel-router.unit.test.ts`

1. **Write the failing test**: 新建 `test/sugent-owner-channel-router.unit.test.ts`，覆盖四项核心行为：
   - 已认证 `owner` 在 `weixin` / `feishu` 私聊消息命中 `OwnerChannelStewardRouter.tryHandleInbound(...)` 时返回 `{ handled: true, reply }` 并复用五维账本与自适应路由；
   - 非 `owner` 外部联系人（`isOwnerPeer: false`）或群聊（`isGroup: true`）严格返回 `{ handled: false }`，绝不越权暴露 `owner_private` 域数据；
   - 主理人发送 `"换更强模型重试"` 或 `"/retry-stronger"` 时直接触发 `retryLastTurnStronger("owner_private")`；
   - 当对话需执行本地终端、文件修改或桌面 GUI 操作而触发 `delegate_local_execution` 工具时，调用注入的 `delegateLocalTask` 端口落盘后台任务并返回回执。
2. **Verify RED**: 运行 `npx vitest run test/sugent-owner-channel-router.unit.test.ts < /dev/null`，预期因文件不存在而失败。
3. **Implement minimal code**:
   - 在 `src/sugent/steward-llm-agent.ts` 的 `StewardLlmToolsPort` 新增可选方法 `delegateLocalTask?(input: { title: string; instruction: string; requireDesktopGui?: boolean; channel?: DropzoneChannel }): Promise<{ taskId: string; status: string }>`，同步在 `STEWARD_CAPABILITY_DESCRIPTORS`、`LLM_TOOLS` 与 `executeExternalTool` 注册 `delegate_local_execution`。
   - 新建 `src/sugent/owner-channel-steward-router.ts`，导出 `OwnerChannelStewardRouter`：校验 `enabled !== false`、`!ev.isGroup`、`ev.isOwnerPeer === true`；识别重试口令；按 `(channel, peerId)` 维护上限 10 轮的滑动历史调用 `steward.converse({ text, history, callerDomain: "owner_private", channel })`；当未配置可用端点时平滑返回 `{ handled: false }` 回退宿主既有通路。
4. **Verify GREEN**: 运行 `npx vitest run test/sugent-owner-channel-router.unit.test.ts test/sugent-steward-llm-agent.unit.test.ts < /dev/null`，确认 `0` 失败。
5. **Commit boundary**: `git add src/sugent/owner-channel-steward-router.ts src/sugent/steward-llm-agent.ts test/sugent-owner-channel-router.unit.test.ts && git commit -m "feat(p0): add OwnerChannelStewardRouter and heavy-task delegation tool"`

---

### Task 4: 前台 One-Jarvis 极简默认态与多 Bot / 旧计费包袱折叠（P0.3a）
- **Wave:** Wave 1 (Parallel)
- **Depends on:** None
- **Touches files:**
  - Modify: `ui/screens/sidebar.js`
  - Modify: `ui/screens/settings.js`
  - Modify: `ui/locales/zh-CN/steward.js`
  - Modify: `ui/locales/en/steward.js`
  - Test: `test/sugent-one-jarvis-ui.unit.test.ts`

1. **Write the failing test**: 新建 `test/sugent-one-jarvis-ui.unit.test.ts`，导入 `shouldShowLegacyMultiBotControls`（从 `ui/screens/sidebar.js` 导出），断言：
   - 默认单 Bot + 未连接旧版 `Modelflare` + 未开启兼容开关时返回 `false`（隐藏“新建多 Bot”与旧充值入口）；
   - 当 `bots.length > 1`、`modelflareConnected === true` 或 `legacyMultiBotEnabled === true` 时返回 `true`（无损保留存量多 Bot 用户视图）；
   - 联动运行 `test/i18n.unit.test.ts` 校验中英文词典键名完全对称。
2. **Verify RED**: 运行 `npx vitest run test/sugent-one-jarvis-ui.unit.test.ts test/i18n.unit.test.ts < /dev/null`，预期因 `shouldShowLegacyMultiBotControls` 未导出而失败。
3. **Implement minimal code**:
   - 在 `ui/screens/sidebar.js` 导出纯判定函数 `shouldShowLegacyMultiBotControls({ botCount, modelflareConnected, legacyFlag })` 并在侧边栏渲染时按该条件折叠多 Bot 列表与旧账户入口。
   - 在 `ui/screens/settings.js` 高级区域提供“显示传统多机器人管理入口”开关（持久化于 `localStorage`），并在 `ui/locales/zh-CN/steward.js` 与 `ui/locales/en/steward.js` 同步补齐双语文案。
4. **Verify GREEN**: 运行 `npx vitest run test/sugent-one-jarvis-ui.unit.test.ts test/i18n.unit.test.ts < /dev/null`，确认 `0` 失败。
5. **Commit boundary**: `git add ui/screens/sidebar.js ui/screens/settings.js ui/locales/zh-CN/steward.js ui/locales/en/steward.js test/sugent-one-jarvis-ui.unit.test.ts && git commit -m "feat(ui): default to One-Jarvis single-steward mode and fold legacy multi-bot clutter"`

---

### Task 5: 宿主 `App` 全量合龙——安全信封 `RuleEvents`、节律守护脉搏与 `BotRuntime` 薄接线（P0.1b + P0.2a + P0.2b）
- **Wave:** Wave 2 (Sequential)
- **Depends on:** Task 1, Task 2, Task 3
- **Touches files:**
  - Modify: `src/sugent/index.ts`
  - Modify: `src/sugent/steward-host-service.ts`
  - Modify: `src/core/runtime.ts`
  - Modify: `src/app.ts`
  - Modify: `src/web/server.ts`
  - Test: `test/sugent-p0-host-loop-closure.e2e.unit.test.ts`

1. **Write the failing test**: 新建 `test/sugent-p0-host-loop-closure.e2e.unit.test.ts`：
   - 验证通过 `app.ruleEvents` 推入含越权控制字段（如 `cwd`、`permission`）的外部事件时，正文被隔离落盘为只读参考文件 `.context/event-*.md` 且越权字段被剥离；
   - 验证微信已绑定 `owner` 的私聊消息通过 `BotRuntime` 薄钩子直达 `SugentStewardHostService` 并共享五维账本，而非 `owner` 消息不被误路由；
   - 验证调用 `await app.runStewardPulseTick(nowMs)` 可触发早间对齐简报二次销账投递与到期的离线园丁巡检，且 `await app.stop()` 后无残留定时器。
2. **Verify RED**: 运行 `npx vitest run test/sugent-p0-host-loop-closure.e2e.unit.test.ts < /dev/null`，预期因宿主未接线而失败。
3. **Implement minimal code**:
   - `src/sugent/index.ts`：导出 `OwnerChannelStewardRouter` 与 `resolveUnifiedCausalLedgerDir`。
   - `src/sugent/steward-host-service.ts`：切换至 `resolveUnifiedCausalLedgerDir`；接入 `delegateLocalTask`；暴露 `listSkillCandidates` / `decideSkillCandidate` 及 `runScheduledPulse(nowMs)`（串联早报冲刷与满足周期/高意外度阈值时的 `runGardenerCycle`）。
   - `src/core/runtime.ts`：在既有 `conciergeIntercept` 旁新增最小可选钩子 `ownerStewardIntercept`，不改写任何上游通道或存储内部实现。
   - `src/app.ts`：(1) 使用 `createEnvelopedRuleEventSink` 包裹 `this.ruleEvents`；(2) 将 `OwnerChannelStewardRouter` 注入 `BotRuntime.ownerStewardIntercept` 并连接后台任务创建委托；(3) 新增 `runStewardPulseTick()`，在 `App.start()` 中（非 `VITEST` 默认开启，测试可通过 `opts.enableStewardPulseTimer` 显式开启）挂载 `15 * 60_000`ms `.unref()` 定时器并在 `App.stop()` 清理。
   - `src/web/server.ts`：挂载 `GET /amb/api/steward/skill-candidates` 与 `POST /amb/api/steward/skill-candidates/decide`。
4. **Verify GREEN**: 运行 `npx vitest run test/sugent-p0-host-loop-closure.e2e.unit.test.ts test/sugent-steward-web-api.unit.test.ts < /dev/null`，确认 `0` 失败。
5. **Commit boundary**: `git add src/sugent/index.ts src/sugent/steward-host-service.ts src/core/runtime.ts src/app.ts src/web/server.ts test/sugent-p0-host-loop-closure.e2e.unit.test.ts && git commit -m "feat(p0): wire security envelope, owner steward bridge, and pulse daemon into App loop"`

---

### Task 6: 注册测试套件、`verify-sugent.mjs` 第 23 节契约门禁与全量实证验收（P0 Gate）
- **Wave:** Wave 3 (Sequential)
- **Depends on:** Task 4, Task 5
- **Touches files:**
  - Modify: `package.json`
  - Modify: `scripts/verify-sugent.mjs`

1. **Write the failing test / contract**: 在 `package.json` 的 `test:sugent` 列表追加 3 个新测试文件；在 `scripts/verify-sugent.mjs` 第 22 节之后新增第 23 节契约断言块，覆盖统一 `CausalLedger` 路径 + Vibe 溯源、技能结晶候选门禁、`OwnerChannelStewardRouter` 公私隔离与 `RuleEvents` 安全信封。
2. **Verify RED / Pre-check**: 若任一导出缺失或契约违背，`node scripts/verify-sugent.mjs` 直接失败退出。
3. **Implement minimal code**: 补齐 `scripts/verify-sugent.mjs` 第 23 节断言并更新汇总输出文案。
4. **Verify GREEN (Full Verification Gate)**:
   - `npm run typecheck < /dev/null`（预期退出码 `0`）
   - `npm run test:sugent < /dev/null`（预期 49 个测试文件全绿）
   - `npx vitest run test/i18n.unit.test.ts < /dev/null`（预期双语词典全绿）
   - `npm run verify:sugent < /dev/null`（预期类型、构建、1–23 节契约及 `docs:check` 0 错误 0 警告）
5. **Commit boundary**: `git add package.json scripts/verify-sugent.mjs && git commit -m "test(p0): register Wave P0 suites and add verify-sugent section 23 gate"`

---

## Phase 1 (Wave P0) 全量验收矩阵（Definition of Done）

| 验收维度 | 对应路线图项 | 客观验收判据（Pass Criteria） | 实证检验命令 |
| :--- | :--- | :--- | :--- |
| **1. 跨渠道唯一大脑合龙** | `P0.1` | 微信/飞书已绑定 `owner` 私聊直接命中 `StewardLlmAgent` + `AdaptiveModelRouter` + 五维账本，支持“换更强模型重试”与重任务委托下沉；外部联系人与群聊 100% 物理隔离。 | `npx vitest run test/sugent-owner-channel-router.unit.test.ts test/sugent-p0-host-loop-closure.e2e.unit.test.ts` |
| **2. 外部事件物理防注入** | `P0.2` | `App.ruleEvents` 投递的外部负载剥离 `cwd`/`agent`/`permission` 越权字段，正文以只读文件落盘至 `.context/event-*.md`。 | `npx vitest run test/sugent-security-envelope.unit.test.ts test/sugent-p0-host-loop-closure.e2e.unit.test.ts` |
| **3. 后台伴行脉搏与全链路溯源** | `P0.2` | `App.start()` 守护脉搏按期触发早报二次销账与周度园丁且 `App.stop()` 零句柄泄漏；`sugent:why` 可完整反查 Vibe Coding 各阶段因果链。 | `npx vitest run test/sugent-vibe-pipeline.unit.test.ts` & `npm run sugent:why` |
| **4. 技能防污染与前台极简收敛** | `P0.3` | 自动提取的 `workflow` 满 3 次先入候选池、未确认前 0 污染提示词且激活上限不超过 12 个；UI 默认隐藏多 Bot 与旧充值入口，双语键值零缺失。 | `npx vitest run test/sugent-kg.unit.test.ts test/sugent-one-jarvis-ui.unit.test.ts test/i18n.unit.test.ts` |
| **5. 零侵入与全仓回归门禁** | 全局铁律 | `packages/dsh-superagent/` 与 `src/channels/` 保持零结构改写；全量类型检查、构建、1–23 节契约断言与文档检查 0 报错。 | `npm run verify:sugent` & `npm run test:sugent` |
