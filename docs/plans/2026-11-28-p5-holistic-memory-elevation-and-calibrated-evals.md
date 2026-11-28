# Sugent 立体记忆全面归一、全表面参谋倍增与校准评测跃迁规划（Wave P5）

- **规划日期**：2026-11-28
- **状态**：待主理人审阅拍板后启动 `P5.1–P5.6` 分梯队并行实施
- **前置基准与依据**：
  - [`2026-11-28 记忆新结构与硅基个体能力定量评测报告`](../../research/2026-11-28-memory-capability-evaluation-report.md)
  - [`2026-11-28 Wave P4 总体规划`](./2026-11-28-stereoscopic-memory-and-silicon-individuality.md)

---

## 0. 新特性「商业策略自省四问」门禁（AGENTS.md §3.3 强制核验）

| 自省维度 | 核心拷问 | 本方案的守线与商业落位 |
| :--- | :--- | :--- |
| **1. 付费锚点（Why Pay & Moat）** | 哪些属开源引流基座，哪些构成商业溢价？ | **开源引流基座**：`StereoscopicAtlas` 单一原生图谱内核、离线同义词/RRF 混合检索、全入口参谋联动与 `eval:memory` 确定性评测集 100% 开源。<br>**商业付费增值**：五平面 + `mind-journal.json` 无损 E2EE 跨端漫游、微信 3 秒转发/Dropzone 联合博弈参谋、双人空间自动星晶提炼与对称口袋闭环，以及行业武器包（FDE / 合同防漏）跨周记忆复利。 |
| **2. 合规与分发（Distribution & ToS Risk）** | 能否通过 macOS 公证、Windows 签名与企业审计？ | SQLite BLOB 轻量向量缓存与本地同义词/Trigram 索引 100% 基于 Node 22 内置 `node:sqlite` + 纯 TypeScript，**零新增原生扩展依赖、零硬编码密钥**，完全兼容 `app.asar` 只读签名外壳。 |
| **3. 离线退路（Sovereignty Fallback）** | `mode: "none"` 免登录无网/无网关时是否独立可用？ | 无网络或无模型网关时，BM25 + 领域同义词/Trigram 扩展、认知阶时间衰减、确定性隐式反馈提取、全表面金丝雀护栏与离线评测集 100% 闭环；BYOK Embedding 与异步小模型结晶均为渐进增强（Graceful Degradation）。 |
| **4. 一人公司运维杠杆（OPC Ops Leverage）** | 是否符合“无状态边缘服务 + 端侧重逻辑”？ | 淘汰 `SugentKnowledgeGraph` 与 `Atlas` 双轨重复搬运，直接复用既有 `atlas.db`、`15` 分钟 `stewardPulseTimer` 与现有 `Eval` 脚本，**不引入独立向量数据库或常驻外置服务**。 |

---

## 一、深水区现状诊断：Wave P4+ 之后仍制约 Sugent 变强的 6 大根因

Wave P4+ 的 40 场景评测与 5 日实战验证证明了新骨架的有效性，但在跨表面源码深挖中仍存在 **6 处影响真实战斗力上限与可信度的结构性短板**：

1. **双图谱并行割裂与 E2EE 跨端同步失真**
   - `p2-host-service.ts` 仅同步旧 `SugentKnowledgeGraph` + `Ledger`，导致跨端同步后丢失 `Atlas` 五平面划分、`principalAcl`、半透膜桥边与 `EpistemicDigestionLoop` 心智日志；`post-turn-digester.ts` 仍先写旧图再被动搬运。
2. **核心参谋面与外事接待面未吃透立体记忆**
   - `universal-dropzone.ts` `handleAdvise` 与 `weixin-quota-and-briefing.ts` 微信 3 秒转发参谋仅查 `Ledger`，看不见 `domain_work:contract-guard` 历史审校与 `self_core` 谈判墓碑；`concierge_envoy` 外事渠道缺少 `M5` 半透认知膜。
3. **词法召回同义盲区、缺时间半衰期与原文溯源断链**
   - `stereoscopic-atlas.ts` 当前仅靠 CJK 2-gram 词法匹配，面对简称/近义表述仍有 `4.2%` 漏召；缺按认知阶差异化的时间半衰期与 `sourceTrust` 加权，且缺失 `ChatTranscriptRecall`（`S0` 原话）与 `S1–S3` 节点的证据溯源边。
4. **认知消化局限于显式正则 + 缺园丁「睡眠重整」主动结晶**
   - `silicon-identity-core.ts` `digestUserFeedbackTurn` 仅匹配字面否定/确认正则，漏捕委婉/隐式反馈；`memory-gardener.ts` 未直连 `Atlas` 执行碎片聚类升阶、矛盾消歧卡推送与 `SKILL.md` 候选提纯。
5. **双人自动晶化、主动节律静音联动与跨仓联调未合龙**
   - `duo/converse` 多轮对话后仍依赖显式触发晶化；`M3` 双人共处留白窗未接入 `proactive-cadence.ts` 自动延后非紧急工作推送；`bigfive-duo-site` 生产流式联调尚待端到端契约验真。
6. **评测体系缺真实多日 Trace 回放与经统计校准的生成质量裁判**
   - 现有 `eval:memory` 为确定性代码断言与本地 Mock，尚缺针对记忆忠实度（Groundedness）、忠诚异议分寸感、双人共情中立度的 `TPR/TNR` 校准二元 LLM-as-Judge 与 Rogan-Gladen 偏差校正。

---

## 二、Wave P5 核心架构升级与修复路线（`P5.1 – P5.6`）

### P5.1 原生单一图谱收口与全平面无损 E2EE 漫游（消除双轨搬运税）
- **根因文件**：[`src/sugent/p2-host-service.ts`](../../src/sugent/p2-host-service.ts)、[`src/sugent/e2ee-sync.ts`](../../src/sugent/e2ee-sync.ts)、[`src/sugent/post-turn-digester.ts`](../../src/sugent/post-turn-digester.ts)
- **实施设计**：
  1. 将 `StereoscopicAtlas` 升格为一等写入源；`PostTurnDigester` 新增 `atlas` 可选注入，按交互表面直接原生写入 `owner_life` / `domain_work:<proj>` / `relational:peer:<id>` 并标注真实 `sourceTrust`，同时同步更新兼容旧接口的 `SugentKnowledgeGraph` 视图。
  2. 在 `e2ee-sync.ts` 与 `p2-host-service.ts` 扩展 `SyncableAtlasSnapshot v2`（向后兼容旧节点/边数组）：无损同步 `plane`、`stratum`、`principalAcl`、`confidence`、`sourceTrust`、`supersededBy`、`membranePolicy` 及 `EpistemicDigestionLoop` 的 `mind-journal.json` 增量，确保跨端拉取零属性退化、零诈尸复活。

### P5.2 混合语义-词法重排引擎（RRF）与 `S0 -> S3` 原话证据链溯源
- **根因文件**：[`src/sugent/stereoscopic-atlas.ts`](../../src/sugent/stereoscopic-atlas.ts)、[`src/sugent/chat-transcript-recall.ts`](../../src/sugent/chat-transcript-recall.ts)
- **实施设计**：
  1. **离线+可选在线双级混合检索**：
     - **零外部依赖基座**：在 `tokenizeForSearch` 引入中英领域同义词与简称双向扩展词典（如 `账期 ↔ 净账期/Net/信用期`、`联调 ↔ 集成验证`、`红线 ↔ 底线/禁忌`）及字符 Trigram 兜底，消除同义表达漏召。
     - **BYOK 可选向量增强**：在 `atlas.db` 同一 SQLite 文件新增 `atlas_embeddings(node_id, dim, vector_blob, model_id)`，配置支持 Embedding 的网关时后台增量索引；召回时以 Reciprocal Rank Fusion（`RRF`，`k=60`）融合 BM25 与向量余弦排序。
  2. **认知阶差异化时间半衰期与权重公式**：
     $$\text{Score} = \text{RRF} \times W(\text{stratum}) \times W(\text{sourceTrust}) \times e^{-\lambda(\text{stratum})\cdot\Delta\text{days}} \times \bigl(1 + 0.15\ln(1 + \text{reinforcements})\bigr)$$
     其中 `raw_episodic` 快速衰减（半衰期约 14 天），`verified_fact` 中速衰减，`crystallized_wisdom` 与 `tombstone` 近零衰减。
  3. **跨层原话证据链反查**：`PostTurnDigester` 与 `ChatTranscriptRecall` 打通 `derived_from_episode` 证据锚点边；仅 `owner:M` 权限在点击工作台星图或溯源追问时可一键下钻回看微信/Web 原对话片段。

### P5.3 全表面参谋能力倍增（`Dropzone` / 微信 3s 参谋与 `M5` 外事认知膜）
- **根因文件**：[`src/sugent/universal-dropzone.ts`](../../src/sugent/universal-dropzone.ts)、[`src/sugent/weixin-quota-and-briefing.ts`](../../src/sugent/weixin-quota-and-briefing.ts)、[`src/sugent/cognitive-membrane.ts`](../../src/sugent/cognitive-membrane.ts)、[`src/sugent/concierge-channel-bridge.ts`](../../src/sugent/concierge-channel-bridge.ts)
- **实施设计**：
  1. **全入口参谋联动立体图谱**：升级 `UniversalDropzone.handleAdvise` / `handleDelegate` 与 `buildThreeSecondForwardedBriefing`，在只读账本的基础上联合检索 `StereoscopicAtlas`（限定 `domain_work:contract-guard` 审校记录、`relational:peer:<id>` 对手方习惯与 `self_core` 谈判墓碑），消除“知道目标但忘了历史踩坑”的决策割裂。
  2. **落地外事接待半透膜 `M5`**：在 `cognitive-membrane.ts` 定义 `concierge_envoy` 外事导出规则——允许向外部草拟服务注入经脱敏的对方沟通偏好（`LanguageProfiler`），并在外发前强制执行 `assertZeroCanaryLeak` 与 `surfaces: ["concierge_envoy"]` 教训过滤，零泄露主人 `owner_life` 与商业底价。

### P5.4 双轨认知消化（规则 + 异步小模型）与园丁「睡眠重整」结晶引擎
- **根因文件**：[`src/sugent/silicon-identity-core.ts`](../../src/sugent/silicon-identity-core.ts)、[`src/sugent/post-turn-digester.ts`](../../src/sugent/post-turn-digester.ts)、[`src/sugent/memory-gardener.ts`](../../src/sugent/memory-gardener.ts)
- **实施设计**：
  1. **隐式反馈 + 异步小模型消化**：保留现有零延迟确定性正则作为 Tier-0；在回合后 `PostTurnDigester` 中增加基于网关 `assessor` 角色的增量结构化消化通道，从委婉对话（如“照上次那么签差点被违约条款坑了”、“这轮排查节奏很舒服”）中抽取隐式 `confirmed` / `falsified` 证据并自动关联既有 `sandbox` 假设。
  2. **园丁「睡眠重整（Sleep Consolidation）」直连 `Atlas`**：让 `memory-gardener.ts` 在周度校准或 Titans 意外度动量 `>= 0.7` 触发时，直接读写 `StereoscopicAtlas`：
     - 同主题积累 `>= 3` 条互恰 `verified_fact` / `raw_episodic` 且零冲突时，自动合成为 1 条 `crystallized_wisdom` 总结节点并挂接 `synthesized_from` 边；
     - 扫描同平面互斥陈述生成「记忆矛盾消歧卡」推送主人确认；
     - 自动淘汰超 7 天未印证的 `sandbox` 假说并归档孤立噪声边，保持图谱高信噪比。

### P5.5 双人自动晶化闭环、节律主动护窗与跨端联调合龙
- **根因文件**：[`src/sugent/duo-steward-crystallizer.ts`](../../src/sugent/duo-steward-crystallizer.ts)、[`src/sugent/proactive-cadence.ts`](../../src/sugent/proactive-cadence.ts)、[`src/sugent/steward-host-service.ts`](../../src/sugent/steward-host-service.ts)
- **实施设计**：
  1. **双人对话自动候选星晶**：在 `duo/converse` 累计足够交互轮次或出现显式共鸣词时，防抖触发异步星晶候选提炼，自动落入待双方点亮池（不自动强制 `crystallized`，保留双方点亮确认主权）；补全 `pocket:M_private` 与 `pocket:W_private` 对称读写测试与工作台状态展示。
  2. **`M3` 护窗接入主动节律队列**：让 `proactive-cadence.ts` 读取 `M3` 双人微约定留白窗（如周五共处晚餐时段），在窗口内自动降级并顺延非紧急工作通知至节律空窗。
  3. **跨仓端到端联调契约**：补齐 `bigfive-duo-site` 流式接入 `/amb/api/steward/duo/converse` 的联调契约校验与降级验证脚本。

### P5.6 三层评测飞轮：扩充代码基准 + 真实 Trace 标注台 + `TPR/TNR` 校准二元 Judge
- **方法论依据**：严格对齐 `eval-audit`、`evaluate-rag`、`write-judge-prompt` 与 `validate-evaluator` 最佳实践（先错误分类学，再二元 Pass/Fail 裁判，最后 `train/dev/test` 切分测 `TPR/TNR` 与 Rogan-Gladen 偏差校正）。
- **根因文件**：[`src/sugent/memory-capability-eval.ts`](../../src/sugent/memory-capability-eval.ts)、[`scripts/eval-memory-capability.mjs`](../../scripts/eval-memory-capability.mjs)
- **实施设计**：
  1. **L1 确定性基准扩容至 65+ 场景（`npm run eval:memory`）**：补入中文近义词/简称难例（Suite A 扩至 20 题）、E2EE 五平面+心智日志往返不失真检验、`handleAdvise` 与微信 3s 转发参谋跨面召回、`M1–M5` 全表面防泄红线（含 `concierge_envoy`）以及园丁睡眠重整与 `proactive-cadence` 护窗测试。
  2. **L2 脱敏多日对话 Trace 黄金集（`test/fixtures/memory-traces/`）**：收集并脱敏沉淀涵盖商务合同、研发排查、微信碎片与双人调停的多日连贯真实回放集，并定义统一错误分类标签（如 `synonym_miss` / `zombie_resurrection` / `tone_sycophancy` / `membrane_side_channel`）。
  3. **L3 经统计校准的二元 LLM-as-Judge（`scripts/eval-memory-judges.mjs`）**：围绕 3 个主观关键维度——**记忆忠实度（Groundedness）**、**忠诚异议分寸感（Dissent Calibration）**、**双人中立共情度（Duo Neutrality）**——构建独立二元（Pass/Fail）裁判 Prompt；严格切分 `train`（少样本）/ `dev`（提示词调优）/ `test`（最终验收），在 `test` 集验证 `TPR >= 0.85` 与 `TNR >= 0.85` 并输出 Rogan-Gladen 校正真实通过率与 95% 置信区间（未配真机 API 时优雅跳过并保留 L1 离线门禁）。

---

## 三、并行实施编排矩阵（2 梯队 × 6 研发泳道）

| 梯队 | 泳道 | 归属任务 | 核心改动模块 | 并发隔离关系 |
| :--- | :---: | :--- | :--- | :--- |
| **第一梯队** | **Lane A** | `P5.1` 单一图谱归一 + `SyncableAtlasSnapshot v2` 无损漫游 | `p2-host-service.ts`、`e2ee-sync.ts`、`post-turn-digester.ts` | 文件集独立，可与 B/C/D **100% 并行** |
| **第一梯队** | **Lane B** | `P5.2` 同义词/Embedding RRF + 半衰期重排 + 原话溯源 | `stereoscopic-atlas.ts`、`chat-transcript-recall.ts` | 文件集独立，可与 A/C/D **100% 并行** |
| **第一梯队** | **Lane C** | `P5.3` `Dropzone.handleAdvise` + 微信 3s 参谋 + `M5` 外事膜 | `universal-dropzone.ts`、`weixin-quota-and-briefing.ts`、`cognitive-membrane.ts` | 文件集独立，可与 A/B/D **100% 并行** |
| **第一梯队** | **Lane D** | `P5.4` 隐式反馈认知消化 + 园丁睡眠重整引擎 | `silicon-identity-core.ts`、`memory-gardener.ts` | 文件集独立，可与 A/B/C **100% 并行** |
| **第二梯队** | **Lane E** | `P5.5` 宿主合龙 + 双人自动晶化 + `M3` 护窗 + 跨仓联调 | `steward-host-service.ts`、`duo-steward-crystallizer.ts`、`proactive-cadence.ts` | 待 Lane A–D 合并后启动，与 Lane F 并行 |
| **第二梯队** | **Lane F** | `P5.6` 65+ 场景 L1 基准 + L2 Trace + L3 校准 Judge 套件 | `memory-capability-eval.ts`、`eval-memory-capability.mjs`、`eval-memory-judges.mjs` | 待 Lane A–D 合并后启动，与 Lane E 并行 |

---

## 四、量化验收门禁表（Legacy 基线 → Wave P4+ → Wave P5 目标）

| 能力维度与核心指标 | Legacy 基线 | Wave P4+ 实测 | **Wave P5 验收目标** |
| :--- | :---: | :---: | :---: |
| **Suite A · 含同义词/简称噪声查询 `Recall@5`** | 25.0% | 95.8% | **`>= 99.0%`**（同义词词典 + RRF 向量融合） |
| **E2EE 跨端同步五平面/桥边/心智日志保留率** | 0.0%（退化扁平） | 部分（仅归档对齐） | **`100.0%`**（`SyncableAtlasSnapshot v2` 无损往返） |
| **`Dropzone.handleAdvise` & 微信 3s 参谋跨面命中率** | 0.0% | 0.0%（仅看账本） | **`100.0%`**（直连 `domain_work` 与 `self_core` 墓碑） |
| **隐式自然语言反馈（无显式关键词）自省捕获率** | 0.0% | 0.0%（仅显式正则） | **`>= 90.0%`**（`assessor` 异步消化 + 隐式规则双轨） |
| **跨主/外事全表面（`M1–M5`）金丝雀泄露率** | 裸传 100.0% | 0.0%（仅 `M1`） | **`0.0%`**（`duo_mediator` + `concierge_envoy` 全覆盖） |
| **L3 主观三维度二元 Judge 校准度（Held-out Test）** | 无在线裁判 | 无在线裁判 | **`TPR >= 0.85` 且 `TNR >= 0.85`**（附 Rogan-Gladen 校正区间） |
| **工程回归门禁** | — | 76 文件 / 299 用例绿 | **`typecheck` + 全量 `test:sugent` + `verify:sugent` 100% 全绿** |

> **云端节点执行提醒**：若在 `gce-vps`（`1~4GB` 内存）等小内存 Linux 节点执行 Wave P5：建议将第一梯队并发行数限制为 `2`（`A+B` 先行、再 `C+D`），并在跑 `vitest` / `npm run test:sugent` 时使用 `--maxWorkers=2`（或 `NODE_OPTIONS=--max-old-space-size=1536`）防 OOM；所有收工前必须运行 `npm run typecheck`、`npm run test:sugent`、`npm run verify:sugent` 与 `npm run eval:memory` 并全绿。
