#!/usr/bin/env node
/**
 * 定量对比 Wave P4+ 新记忆结构与 Legacy 基线的评测脚本
 * 运行：`npm run build && node scripts/eval-memory-capability.mjs --write-report`
 */
import fs from "node:fs";
import path from "node:path";
import { runMemoryCapabilityBenchmark } from "../dist/src/sugent/index.js";

const report = await runMemoryCapabilityBenchmark();
console.log(report.markdownTable);

if (process.argv.includes("--write-report")) {
  const outPath = path.join(process.cwd(), "research", "2026-11-28-memory-capability-evaluation-report.md");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const doc = [
    "# Sugent 记忆新结构与硅基个体能力定量评测报告（Wave P4+）",
    "",
    `- **评测生成时间**：\`${report.generatedAtIso}\``,
    `- **评测场景规模**：共 ${report.totalScenarios} 个对照测试用例（Suite A 12 检索查询 / Suite B 6 时序防诈尸链 / Suite C 12 自省纠偏与忠诚异议 / Suite D 4 跨面宿主协同 / Suite E 6 对抗防泄测试 × 12 金丝雀）`,
    "- **评测方法**：对照 `evaluate-rag`（Recall@5、Precision@5、MRR、NDCG@5、TwoHopRecall@5）与 `write-code-eval`（ZombieLeakRate、CanaryLeakRate、Dissent P/R）客观代码断言。",
    "",
    "## 1. 核心指标对照表（Legacy 基线 vs Wave P4+ 新架构）",
    "",
    report.markdownTable,
    "",
    "## 2. 本轮实测暴露并顺手修复的 6 处宿主消费断点与跨膜侧信道",
    "",
    "1. **LlmAgent 图谱召回断流修复**：`steward-host-service.ts` 中 `toolsPort.recallKnowledgeSubgraph` 原仅查扁平 `knowledgeGraph.recallSubgraph`，现切换为 `StereoscopicAtlas.recallStereoscopic`（返回 5 平面 × 认知阶 + 跨膜桥边）。",
    "2. **UniversalDropzone 立体召回接入**：`handleRecall` 优先走 `atlasRecall`，查全 `self_core`/`domain_work` 等跨面知识。",
    "3. **对话内自省闭环即时闭环**：`EpistemicDigestionLoop.digestUserFeedbackTurn` 在主人一句自然语言指出建议有效或踩坑时，当轮立即入账 `crystallized` 或 `self:tombstone` 并注入本轮上下文。",
    "4. **`domain_work` 工程与武器包全沉淀**：`comprehendSession`、`VibeCoding` 门禁、`runIndustrialFdePack`、`runContractGuardPack` 均实时写入 `domain_work:*` 平面，并随 `buildOwnerAgentBrief()` 同步回 DSH 主脑与微信分支。",
    "5. **跨端同步去诈尸对齐**：`mutateAtlasNode`（`supersede_node` / `tombstone_node`）联动清理遗留图谱 `archiveNode`，消除 E2EE 复活风险。",
    "6. **双人调停 M1 教训侧信道封堵**：5 日端到端压测直检 `/amb/api/steward/duo/converse` 发送给模型的真实 `system prompt` 时，暴露 `buildDuoContextInjections` 无差别注入主人的 `calibratedLessons` 导致商业客户避坑墓碑越界。现通过 `getCalibratedLessons(4, { surfaces: [\"duo_mediator\"] })` + 金丝雀二次过滤彻底封堵。",
    "",
  ].join("\n");
  fs.writeFileSync(outPath, doc, "utf8");
  console.log(`\nReport written to ${outPath}`);
}
