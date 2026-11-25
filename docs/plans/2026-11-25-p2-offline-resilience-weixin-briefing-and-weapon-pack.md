# Wave P2：合盖离线韧性、微信 3 秒转发参谋与标杆行业武器包实施方案

**Goal:** 完成 `docs/ROADMAP.md` 最后一轮战役 Wave P2（`P2.1–P2.3`），交付端侧防休眠与合盖离线 E2EE 摘要/待办暂存舱、微信 iLink 自适应配额保护与 3 秒转发参谋工作流、以及基于 `Cowork Hub + Sugent Edge` 的两大标杆商业武器包与 14 天实盘压测证明账本。
**Spec Reference:** `docs/ROADMAP.md` 第二章 Wave P2（`P2.1`、`P2.2`、`P2.3`）及 `AGENTS.md` 第 1–5 章工程与商业护栏。
**Tech Stack & Test Runner:** TypeScript ESM (`NodeNext`), Node.js `node:crypto` (`AES-256-GCM`), Vitest (`npx vitest run`), `npm run verify:sugent`.
**Execution Pipeline:** `subagent-orchestrator` -> `code-review` -> `verification-gate`

## 0. 商业策略自省四问（AGENTS.md §3.3 强制门禁）

| 自省维度 | 本方案核验结论 |
| :--- | :--- |
| **1. 付费锚点（Why Pay & Moat）** | `P2.1` 跨端 E2EE 离线摘要舱与待办暂存队列、`P2.3` 工业现场 FDE 异常诊断包与合同报价防漏审校包直接构成 Sugent Pro/Team 与行业交付的核心付费锚点；`P2.2` 3 秒转发参谋结合五维账本历史底价与证伪墓碑，提供纯代码面板（T3 Code 等）无法覆盖的商务防社死确定性价值。 |
| **2. 合规与分发（Distribution & ToS Risk）** | `P2.1` 仅使用标准桌面电源唤醒锁接口且设自动超时释放；`P2.2` 严守腾讯开源 `openclaw-weixin` iLink 边界，只解析用户主动合并转发或截图文本，绝不触碰个人微信原生窗口内存；`P2.3` 全程走 `sealExternalEvent` 只读文件信封与 `CoworkHitlClient` 角色门禁，零硬编码密钥。 |
| **3. 离线退路（Sovereignty Fallback）** | 在 `mode: "none"` 免登录离线主权模式下，防休眠控制、本地 E2EE 快照加解密、微信配额折叠、本地五维账本 3 秒转发参谋、以及两大武器包的本地确定性规则校验与 14 天压测统计均 100% 单机闭环可用。 |
| **4. 一人公司运维杠杆（OPC Ops Leverage）** | 延续「无状态边缘密文存储 + 端侧重逻辑」原则：云端只存端侧密封好的 `ZeroKnowledgeEnvelope` JSON，所有规则核验、底价召回与异常分级均在端侧确定性完成，零额外后端运维负担。 |

## Wave Summary
- **Wave 1 (Parallel Fan-Out — 3 Disjoint Subsystems):**
  - Task 1 (`P2.1`): `src/sugent/offline-digest-and-power-guard.ts` + `test/sugent-offline-digest-and-power-guard.unit.test.ts`
  - Task 2 (`P2.2`): `src/sugent/weixin-quota-and-briefing.ts` + `test/sugent-weixin-quota-and-briefing.unit.test.ts`
  - Task 3 (`P2.3`): `src/sugent/weapon-packages.ts` + `test/sugent-weapon-packages.unit.test.ts`
- **Wave 2 (Sequential Host Integration & Verification):**
  - Task 4: Wire into `src/sugent/steward-host-service.ts`, `src/sugent/index.ts`, `package.json`, `scripts/verify-sugent.mjs` (Section 26), `docs/ROADMAP.md`, `STATUS.md`, and `docs/decisions/steward-notes.md`; run two-axis `code-review` and `verification-gate`.

### Task 1: P2.1 防休眠控制器与云端 E2EE 离线摘要舱及待办暂存队列
- **Wave:** Wave 1 (Parallel)
- **Depends on:** None
- **Touches files:**
  - Create: `src/sugent/offline-digest-and-power-guard.ts`
  - Test: `test/sugent-offline-digest-and-power-guard.unit.test.ts`

1. **Write the failing test**: 验证 `PowerSaveBlockerController` 开关与最大驻留超时自动释放；验证 `E2eeOfflineDigestVault` 从 `StewardshipLedger` 生成脱敏路径后的轻量只读摘要并经 `sealZeroKnowledgeEnvelope` 加密，以及离线期间压入加密待办后在开盖唤醒时幂等解密回灌进 `StewardshipLedger`。
2. **Verify RED**: `npx vitest run test/sugent-offline-digest-and-power-guard.unit.test.ts` 因模块不存在失败。
3. **Implement minimal code**: 实现 `PowerSaveBlockerController`、`buildOfflineLedgerDigest`、`E2eeOfflineDigestVault`（含 `sealDigest`、`openDigest`、`sealOfflineTask`、`drainOfflineTasksIntoLedger`）。
4. **Verify GREEN**: 单测 100% 通过且密文不含明文路径或敏感词。

### Task 2: P2.2 微信 iLink 配额自适应保护与「3 秒转发参谋」工作流
- **Wave:** Wave 1 (Parallel)
- **Depends on:** None
- **Touches files:**
  - Create: `src/sugent/weixin-quota-and-briefing.ts`
  - Test: `test/sugent-weixin-quota-and-briefing.unit.test.ts`

1. **Write the failing test**: 验证 `WeixinAdaptiveQuotaGuard` 在高水位直发、低水位（`<= 3`）自动折叠非紧急消息为单张汇总卡、零配额或 `expired` 时自动切飞书/备用通道告警；验证 `buildThreeSecondForwardedBriefing` 解析合并转发记录、经安全信封隔离、3 秒内召回客户信任等级/禁忌雷区/历史底价红线并输出双风格可复制回复话术。
2. **Verify RED**: `npx vitest run test/sugent-weixin-quota-and-briefing.unit.test.ts` 因模块不存在失败。
3. **Implement minimal code**: 实现 `WeixinAdaptiveQuotaGuard`、`parseForwardedChatTranscript`、`buildThreeSecondForwardedBriefing`。
4. **Verify GREEN**: 单测 100% 通过。

### Task 3: P2.3 端-边联邦标杆行业武器包（工业 FDE 诊断包 + 合同报价防漏包 + 14 天压测账本）
- **Wave:** Wave 1 (Parallel)
- **Depends on:** None
- **Touches files:**
  - Create: `src/sugent/weapon-packages.ts`
  - Test: `test/sugent-weapon-packages.unit.test.ts`

1. **Write the failing test**: 验证 `runIndustrialFdeDiagnosticPack` 对 MES/ERP 异常工单表执行安全信封封装、SLA 超时与重复工位根因归类及 Cowork Staging 审批草案生成；验证 `runContractQuoteGuardPack` 对照账本 `hard_redline` / `tombstone` 与历史报价档案拦截破底价或账期超限风险并产出 `RedlineDiffCard`；验证 `WeaponSoakTelemetryLedger` 沉淀 14 天工时节省、省钱比例与零越权商业证明报告。
2. **Verify RED**: `npx vitest run test/sugent-weapon-packages.unit.test.ts` 因模块不存在失败。
3. **Implement minimal code**: 实现两大标准 `WeaponPackage` 执行器与 `WeaponSoakTelemetryLedger`。
4. **Verify GREEN**: 单测 100% 通过。

### Task 4: 宿主接线、第 26 节契约门禁与路线图全量收官
- **Wave:** Wave 2 (Sequential)
- **Depends on:** Task 1, Task 2, Task 3
- **Touches files:**
  - Modify: `src/sugent/steward-host-service.ts`, `src/sugent/index.ts`, `package.json`, `scripts/verify-sugent.mjs`, `docs/ROADMAP.md`, `STATUS.md`, `docs/decisions/steward-notes.md`
