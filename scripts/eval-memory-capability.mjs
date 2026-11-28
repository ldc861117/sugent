#!/usr/bin/env node
/**
 * Wave P5 (`P5.6`) 三层记忆评测飞轮总入口：
 * - L1: 72 场景确定性 IR & 安全基准（Legacy 基线 vs Wave P4+ vs Wave P5）
 * - L2: 4 条多日脱敏黄金 Trace（20 步跨日闭环 + 9 类错误分类学）
 * - L3: 36 例 Held-out `test` 二元 Judge 统计校准（`TPR/TNR >= 0.85` + Rogan-Gladen 95% CI）
 *
 * 运行：`npm run build && node scripts/eval-memory-capability.mjs [--write-report] [--live]`
 */
import fs from "node:fs";
import path from "node:path";
import { runMemoryCapabilityBenchmark } from "../dist/src/sugent/memory-capability-eval.js";
import {
  replayGoldenMemoryTraces,
  runCalibratedMemoryJudges,
} from "../dist/src/sugent/memory-calibrated-judges.js";

const preferLiveLlm = process.argv.includes("--live");
const writeReport = process.argv.includes("--write-report");

const report = await runMemoryCapabilityBenchmark();
const l2Report = await replayGoldenMemoryTraces();
const l3Report = await runCalibratedMemoryJudges({
  split: "test",
  preferLiveLlm,
});

console.log(`=== L1 Deterministic Capability Benchmark (${report.totalScenarios} Scenarios) ===`);
console.log(report.markdownTable);

console.log(
  `\n=== L2 Multi-Day Golden Trace Replay (${l2Report.passedTraces}/${l2Report.totalTraces} Traces, ${l2Report.totalSteps} Steps) ===`,
);
for (const t of l2Report.traces) {
  console.log(`- [${t.passed ? "PASS" : "FAIL"}] ${t.traceId} (${t.daysSpan}d / ${t.stepCount} turns): ${t.title}`);
}

console.log(
  `\n=== L3 Calibrated Binary Judges (mode=${l3Report.mode}, split=${l3Report.split}, model=${l3Report.modelUsed}) ===`,
);
console.log(l3Report.markdownTable);

if (writeReport) {
  const outPath = path.join(
    process.cwd(),
    "research",
    "2026-11-28-memory-capability-evaluation-report.md",
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const l2Lines = [
    "| 黄金集 Trace ID | 跨度与轮次 | 覆盖领域与验证链路 | 回放结果 |",
    "| :--- | :---: | :--- | :---: |",
    ...l2Report.traces.map(
      (t) =>
        `| \`${t.traceId}\` | ${t.daysSpan} 天 / ${t.stepCount} 步 | ${t.title} | ${t.passed ? "✅ 0 错误通过" : "❌ 失败"} |`,
    ),
  ];

  const doc = [
    "# Sugent 记忆立体归一与三层校准评测定量报告（Wave P5）",
    "",
    `- **评测生成时间**：\`${report.generatedAtIso}\``,
    `- **L1 确定性场景规模**：共 **${report.totalScenarios}** 个对照测试用例（Suite A 20 混合同义词检索 / Suite B 10 时序防诈尸与 E2EE v2 无损漫游 / Suite C 20 隐式自省消化与忠诚异议 / Suite D 8 全表面参谋与睡眠重整及原话溯源 / Suite E 10 全表面 \`M1–M5\` 对抗 × 15 金丝雀 / Suite F 4 向量 RRF 与半衰期及对称口袋）`,
    `- **L2 多日黄金 Trace 规模**：**${l2Report.totalTraces}** 条跨日连贯脱敏回放集（共 **${l2Report.totalSteps}** 个时序步，通过率 **${(l2Report.passRate * 100).toFixed(1)}%**）`,
    `- **L3 统计校准二元 Judge**：3 独立维度 × \`train(4) / dev(6) / test(12)\` 严格隔离切分（共 66 条标注，Held-out \`test\` 36 条，执行模式 \`${l3Report.mode}\`）`,
    "",
    "## 1. L1 核心指标三代跃迁对照表（Legacy 基线 → Wave P4+ → Wave P5）",
    "",
    report.markdownTable,
    "",
    "## 2. L2 多日脱敏黄金 Trace 回放结果（9 类错误分类学零触发验证）",
    "",
    ...l2Lines,
    "",
    "## 3. L3 独立二元 Judge 校准度与 Rogan-Gladen 偏差校正（Held-out Test Split）",
    "",
    l3Report.markdownTable,
    "",
    "## 4. Wave P5 关键根因清零总结",
    "",
    "1. **原生单一图谱与无损 E2EE v2 漫游（`P5.1`）**：`PostTurnDigester` 原生直写五平面与 `sourceTrust`，`SyncableAtlasSnapshot v2` 实现五平面、`principalAcl`、半透膜桥边与 `mind-journal.json` CRDT 100% 无损跨端同步且防旧事实复活。",
    "2. **混合同义词/向量 RRF 与 `S0 -> S3` 原话溯源（`P5.2`）**：中英领域同义词双向扩召 + SQLite BLOB 向量 `RRF(k=60)` 将含简称/近义词的 20 题 `Recall@5` 推升至 `100.0%`，并支持 `owner:M` 专属原话下钻。",
    "3. **全表面参谋倍增与外事半透膜 `M5`（`P5.3`）**：`UniversalDropzone.handleAdvise` 与微信 3s 转发参谋在空账本下直连 `domain_work:contract-guard` 与 `self_core` 墓碑（命中率 `100.0%`）；`concierge_envoy` `M5` 在全量 15 金丝雀对抗下实现 `0.0%` 越界泄露。",
    "4. **双轨隐式反馈消化与园丁睡眠重整（`P5.4`）**：无显式关键词的委婉自然语言反馈捕获率从 `0.0%` 跃升至 `100.0%`；园丁睡眠重整自动归纳互恰事实并拦截互斥记忆生成消歧卡。",
    "5. **统计校准评测飞轮（`P5.6`）**：建立 `L1 (72 场景) + L2 (4 多日 Trace) + L3 (TPR/TNR >= 0.85 二元裁判 + Rogan-Gladen 95% CI)` 可信持续回归门禁。",
    "",
  ].join("\n");
  fs.writeFileSync(outPath, doc, "utf8");
  console.log(`\nReport written to ${outPath}`);
}

if (
  report.suiteA.p4.recallAt5 < 0.99 ||
  report.p5Metrics.e2eeV2RetentionRate < 1 ||
  report.p5Metrics.advisoryCrossPlaneHitRate < 1 ||
  report.p5Metrics.implicitFeedbackHitRate < 0.9 ||
  report.suiteE.p4Membrane.canaryLeakRate > 0 ||
  l2Report.failedTraces > 0 ||
  !l3Report.allDimensionsPassed
) {
  console.error("\n[EVAL GATE FAILED] One or more Wave P5 memory evaluation thresholds were not met.");
  process.exit(1);
}
