# Sugent 双人关系幕僚与记忆晶化引擎（Duo Steward & Crystallizer）试点方案

- **日期**：2026-11-27
- **状态**：实施落地（Andy & Gillna `bigfive-duo-site` 实盘试点）
- **关联仓库**：`ldc861117/sugent`（主权幕僚与晶化中枢） × `ldc861117/bigfive-duo-site`（双星关系数字档案馆试点宿主）

---

## 0. 新特性「商业策略自省四问」门禁（AGENTS.md 强制核验）

| 自省维度 | 核心拷问与守线决策 |
| :--- | :--- |
| **1. 付费锚点（Why Pay & Moat）** | **商业付费增值（个人/伴侣高留存场景武器包 `duo-relationship-steward`）**：开源基座提供单人五维账本与通用图谱；面向伴侣/家庭的「关系记忆晶化、不翻旧账时效更替、跨源周期深度复盘与双人微约定回响」构成强情感粘性的订阅增值武器包。相比大厂通用办公助手，Sugent 以**物理隔离隐私主权、平等中立不偏袒护栏与渐进印证晶化机制**建立差异化壁垒。 |
| **2. 合规与分发（Distribution & ToS Risk）** | **零违规、零灰盒强依赖**：核心模块纯 TypeScript 标准库实现，无任何硬编码密钥、无客户端二进制改动，100% 兼容 macOS 公证与 Windows 签名；预留的微信双人群扩展口严格复用外置 Loopback 边车协议与 `0o400` 安全信封隔离，默认静默关闭。 |
| **3. 离线退路（Sovereignty Fallback）** | **双端 100% 离线/单机闭环自洽**：在 `sugent` 侧 `mode: "none"` 免登录离线主权模式下，本地 BYOK 或确定性提炼器可独立完成关系晶体凝练、时效更替与微约定追踪；在 `bigfive-duo-site` 侧采用**联邦同构双保险**——优先调用 `SUGENT_DUO_HUB_URL` 中枢，未配置或网络抖动时自动零感降级至站内同构晶化内核，绝不因单点断连中断服务。 |
| **4. 一人公司运维杠杆（OPC Ops Leverage）** | **零新守护进程、薄适配复用**：直接复用既有 `SugentKnowledgeGraph`（`exclusive: true` 时效排他边）、`security-envelope.ts`（`sealExternalEvent`）与 `gateway.ts` 四角色模型路由；HTTP 联邦层仅在 `src/web/server.ts` 挂载最小权限令牌 `SUGENT_DUO_BRIDGE_TOKEN` 作用域（`/amb/api/steward/duo/*`），日常运维负担为零。 |

---

## 1. 背景与目标

`bigfive-duo-site` 原有的「观星仙人（Stargazing Sage）」虽具备基础 RAG 与月度长卷，但存在三项结构性局限：
1. **角色戏服感过重且缺乏结构化沉淀**：“本仙人 / 吾乃”古风口吻在深度复盘时削弱了现代清晰度，且对话中达成的珍贵共识阅后即散，无法转化为持久演进的结构化记忆晶体。
2. **缺乏时效认知更替（易翻旧账）**：关系进入新稳态后，缺乏类似 Sugent `exclusive: true` / `supersededAt` 的认知迭代机制，容易在提示卡或回答中复读已化解的早期摩擦。
3. **缺乏双人共阅确认门禁与微约定闭环**：近日点校准与深度对话中产生的 `Keep / Adjust / 共同心愿` 缺少温和追踪与回响机制。

本次试点目标：
- 用 **「Sugent · 星轨幕僚」** 全面接管并升级原「观星仙人」全链路（右下角流式对话、首页轨道洞察与校准提示卡、每日星象共鸣解读、周期总结审计与月度情景长卷）；
- 在 `sugent` 主仓沉淀物理隔离的 **`DuoStewardCrystallizer`（双人关系幕僚与记忆晶化引擎）** 并暴露最小权限联邦接口，与 `bigfive-duo-site` 站内同构晶化内核组成双保险高可用闭环。

---

## 2. 核心架构与物理隔离红线

### 2.1 公私域绝对物理隔离（Zero `owner_private` Leakage）
- `DuoStewardCrystallizer` 将每个双人空间独立存储于 `<dataDir>/duo-spaces/<safeSpaceId>/`（目录权限 `0o700`，数据文件 `0o600`），拥有独立的 `SugentKnowledgeGraph` 实例（`duo-kg/`）。
- **硬红线**：双人空间绝对不读取主理人个人的 `StewardshipLedger`（`owner_private` / `work_project` 商业底价、工作合同、个人私聊记录）；`SUGENT_DUO_BRIDGE_TOKEN` 经 SHA-256 `crypto.timingSafeEqual` 校验，在 `src/web/server.ts` 仅放行 `/amb/api/steward/duo/*` 路径，访问 `/amb/api/steward/workbench` 等主理人接口一律返回 `401`。
- 所有外部入站文本（网页对话、日志切片、预留微信助理号双人群消息）一律先经 `sealExternalEvent(..., { privilegedFieldMode: "strip" })` 密封为 `0o400` 只读安全信封，并经 `looksSecret` 拦截密钥入库。

### 2.2 四类关系星晶（`DuoCrystal`）与渐进印证生命周期
1. **晶体分类（`DuoCrystalKind`）**：
   - `consensus_tacit`（默契与共识）：双方已验证舒适有效的相处节奏与温存仪式；
   - `friction_antidote`（摩擦触发器与安抚配方）：以无指责视角提炼“外显信号 → 内在真实防御/需求 → 温和调频动作”；
   - `stage_evolution`（阶段新演化）：关系迈入新阶段的标志性认知跃迁；
   - `micro_card`（专属动力学微卡片）：从两人真实经历生长出的定制关系动力学模型。
2. **DreamSandbox 晶化门禁与时效更替（不翻旧账）**：
   - 初次提炼进入 `candidate`（待共阅凝结），支持任一方或双方在站内点亮共鸣确认（`endorse` / `crystallize`），或在不同周期累计印证满 `3` 次自动晋升为 `crystallized`；
   - 每个晶体绑定语义主题键 `topicKey`：当同一 `topicKey` 下新晶体晋升为 `crystallized` 时，自动将同主题旧晶体置为 `superseded`（记录 `supersededBy` 与 `supersededAt`），同步在独立 `SugentKnowledgeGraph` 中写入 `exclusive: true` 排他边。系统提示词召回层**严格过滤 `superseded` 与 `archived` 晶体**，根除翻旧账。

### 2.3 双人微约定追踪（`DuoMicroCommitment`）与跨源深度复盘（`DuoSynthesisReport`）
- **双人微约定**：从已解锁月度校准（`Keep / Adjust / QualityTime / SafetyNet`）及对话中捕捉微约定，支持温和记录回响（`echoCount` + `lastEchoNote`）与达成归档，绝不采用绩效考核式催办语气。
- **跨源深度总结分析**：支持按 `7d` / `30d` / `quarter` / `topic` 串联共享日志、大事纪、已解锁校准、聊天切片、合盘相位与现行有效星晶，输出结构化档案报告并同步派生新候选星晶。
- **网关中立选模**：在 `sugent` 侧统一经 `resolveSugentGatewayConfig` + `selectModelForRole` 按角色路由（提炼走 `steward`，深度复盘与星轨对话走 `executor`，轻量检索评估走 `assessor`）。

---

## 3. 实施与验证清单

1. **`sugent` 侧（零侵入扩展）**：
   - 新增 [`src/sugent/duo-steward-crystallizer.ts`](../../src/sugent/duo-steward-crystallizer.ts) 并导出至 [`src/sugent/index.ts`](../../src/sugent/index.ts)
   - 在 [`src/sugent/steward-host-service.ts`](../../src/sugent/steward-host-service.ts) 与 [`src/web/server.ts`](../../src/web/server.ts) 薄层挂载 `duoCrystallizer` 与 `/amb/api/steward/duo/*` 最小权限联邦路由（`SUGENT_DUO_BRIDGE_TOKEN`）
   - 新增单测 [`test/sugent-duo-crystallizer.unit.test.ts`](../../test/sugent-duo-crystallizer.unit.test.ts) 与 [`scripts/verify-sugent.mjs`](../../scripts/verify-sugent.mjs) 第 30 节契约门禁
   - 更新 [`docs/decisions/steward-notes.md`](../decisions/steward-notes.md) 与根目录 [`STATUS.md`](../../STATUS.md)
2. **`bigfive-duo-site` 侧（全链路升级试点）**：
   - 数据库契约新增 `duo_crystals`、`duo_commitments`、`duo_synthesis_reports`（含独立 `SCHEMA_DDL_STATEMENTS` 容错建表与 `mockStore` 内存测试支持）
   - 新增 `server/sugentSteward.ts`（联邦桥接 + 本地同构晶化双保险）与 `server/routers/sugentRouter.ts`（`trpc.sugent.*`）
   - 升级 `personalityChat.ts`、`memoryLayer.ts`、`kgAnalysis.ts`、`astrologyRouter.ts`、`reconcileRouter.ts` 为「Sugent · 星轨幕僚」并注入有效星晶与微约定上下文
   - 升级 `FloatingChatWidget.tsx`（含「星轨对话 · 关系星晶 · 深度复盘」三栏与对话一键凝晶）、`Home.tsx`、`BigFive.tsx`、`Reconcile.tsx`、`Astrology.tsx`、`AIChatBox.tsx`、`BigFiveDeepSections.tsx`、`TimelineFeedCard.tsx` 与 `VersionNotifier.tsx`（`v2.1.0`）
