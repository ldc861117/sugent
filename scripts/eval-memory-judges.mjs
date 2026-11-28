#!/usr/bin/env node
/**
 * Wave P5 (`P5.6`) — L2 多日脱敏 Trace 黄金集回放 + L3 经统计校准二元 Judge 门禁脚本
 * 运行：`npm run build && node scripts/eval-memory-judges.mjs [--live] [--split=test|dev]`
 */
import {
  replayGoldenMemoryTraces,
  runCalibratedMemoryJudges,
} from "../dist/src/sugent/memory-calibrated-judges.js";

const args = process.argv.slice(2);
const preferLiveLlm = args.includes("--live");
const splitArg = args.find((a) => a.startsWith("--split="))?.split("=")[1];
const split = splitArg === "dev" ? "dev" : "test";

const l2Report = await replayGoldenMemoryTraces();
const l3Report = await runCalibratedMemoryJudges({
  split,
  preferLiveLlm,
});

console.log("=== L2 Multi-Day De-identified Golden Trace Replay ===");
console.log(
  `Traces: ${l2Report.passedTraces}/${l2Report.totalTraces} passed (${l2Report.totalSteps} chronological steps, passRate=${(l2Report.passRate * 100).toFixed(1)}%)`,
);
for (const trace of l2Report.traces) {
  console.log(
    `- [${trace.passed ? "PASS" : "FAIL"}] ${trace.traceId} (${trace.daysSpan}d, ${trace.stepCount} steps): ${trace.title}`,
  );
  for (const f of trace.failures) {
    console.error(`    ! Day ${f.day} (${f.stepId}) [${f.failureCode}]: ${f.detail}`);
  }
}

console.log(`\n=== L3 Statistically Calibrated Binary Judges (mode=${l3Report.mode}, model=${l3Report.modelUsed}, split=${l3Report.split}) ===`);
console.log(l3Report.markdownTable);

if (l2Report.failedTraces > 0 || !l3Report.allDimensionsPassed) {
  console.error(
    `\n[EVAL GATE FAILED] L2 failedTraces=${l2Report.failedTraces}, L3 allDimensionsPassed=${l3Report.allDimensionsPassed}`,
  );
  process.exit(1);
}

console.log("\n[EVAL GATE PASSED] L2 (100% golden traces) & L3 (all TPR >= 0.85, TNR >= 0.85) verified.");
