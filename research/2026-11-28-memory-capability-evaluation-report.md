# Sugent 记忆新结构与硅基个体能力定量评测报告（Wave P4+）

- **评测生成时间**：`2026-11-28T06:53:22.933Z`
- **评测场景规模**：共 40 个对照测试用例（Suite A 12 检索查询 / Suite B 6 时序防诈尸链 / Suite C 12 自省纠偏与忠诚异议 / Suite D 4 跨面宿主协同 / Suite E 6 对抗防泄测试 × 12 金丝雀）
- **评测方法**：对照 `evaluate-rag`（Recall@5、Precision@5、MRR、NDCG@5、TwoHopRecall@5）与 `write-code-eval`（ZombieLeakRate、CanaryLeakRate、Dissent P/R）客观代码断言。

## 1. 核心指标对照表（Legacy 基线 vs Wave P4+ 新架构）

| 评测维度与指标 | Legacy 基线（扁平图谱/无状态/切脑） | Wave P4+（立体图谱/硅基核/认知膜） | 实测提升 / 结论 |
| :--- | :---: | :---: | :--- |
| **Suite A · 中文噪声查询 Recall@5** | 25.0% | **95.8%** | +70.8% |
| **Suite A · 首条命中率 MRR** | 0.250 | **1.000** | +0.750 |
| **Suite A · 认知阶排序 NDCG@5** | 0.250 | **0.978** | +0.728 |
| **Suite A · 跨平面两跳 TwoHopRecall@5** | 0.0% | **100.0%** | +100.0% |
| **Suite A · 空查询 `maxNodes` 防爆约束** | ❌ 失控返全库 | **✅ 严格截断** | 修复上下文爆仓 |
| **Suite B · 旧事实诈尸泄露率** | 100.0% | **0.0%** | 归零（根除陈旧结论干扰） |
| **Suite B · 最新结论 Top-1 准确率** | 0.0% | **100.0%** | +100.0% |
| **Suite C · 对话反馈自省纠偏率** | 0.0% | **100.0%** | 实现回合内立碑/转正 |
| **Suite C · 忠诚异议识别 (P / R)** | 0.0% / 0.0% | **100.0% / 100.0%** | 高精零误报防偏航镜像 |
| **Suite D · 跨表面/武器包全触达率** | 50.0% | **100.0%** | +50.0%（注入主脑 2 条域沉淀） |
| **Suite E · 双人盲区上下文效用 (vs 切脑)** | 25.0% | **90.0%** | +65.0% 现实感知 |
| **Suite E · 12 金丝雀越界泄露率 (vs 裸传 100.0%)** | 裸传 100.0% | **0.0%** | 零原文/金额/客户名泄露 |

## 2. 本轮实测暴露并顺手修复的 6 处宿主消费断点与跨膜侧信道

1. **LlmAgent 图谱召回断流修复**：`steward-host-service.ts` 中 `toolsPort.recallKnowledgeSubgraph` 原仅查扁平 `knowledgeGraph.recallSubgraph`，现切换为 `StereoscopicAtlas.recallStereoscopic`（返回 5 平面 × 认知阶 + 跨膜桥边）。
2. **UniversalDropzone 立体召回接入**：`handleRecall` 优先走 `atlasRecall`，查全 `self_core`/`domain_work` 等跨面知识。
3. **对话内自省闭环即时闭环**：`EpistemicDigestionLoop.digestUserFeedbackTurn` 在主人一句自然语言指出建议有效或踩坑时，当轮立即入账 `crystallized` 或 `self:tombstone` 并注入本轮上下文。
4. **`domain_work` 工程与武器包全沉淀**：`comprehendSession`、`VibeCoding` 门禁、`runIndustrialFdePack`、`runContractGuardPack` 均实时写入 `domain_work:*` 平面，并随 `buildOwnerAgentBrief()` 同步回 DSH 主脑与微信分支。
5. **跨端同步去诈尸对齐**：`mutateAtlasNode`（`supersede_node` / `tombstone_node`）联动清理遗留图谱 `archiveNode`，消除 E2EE 复活风险。
6. **双人调停 M1 教训侧信道封堵**：5 日端到端压测直检 `/amb/api/steward/duo/converse` 发送给模型的真实 `system prompt` 时，暴露 `buildDuoContextInjections` 无差别注入主人的 `calibratedLessons` 导致商业客户避坑墓碑越界。现通过 `getCalibratedLessons(4, { surfaces: ["duo_mediator"] })` + 金丝雀二次过滤彻底封堵。
