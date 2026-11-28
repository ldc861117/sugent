import { describe, expect, it, vi } from "vitest";
import { resolveSugentGatewayConfig } from "../src/sugent/gateway.js";
import {
  buildBinaryJudgePrompt,
  computeBinaryJudgeCalibration,
  computeRoganGladenCorrection,
  JUDGE_DIMENSIONS,
  loadJudgeCalibrationDataset,
  MEMORY_EVAL_FAILURE_CODES,
  parseBinaryJudgeResponse,
  replayGoldenMemoryTraces,
  runCalibratedMemoryJudges,
} from "../src/sugent/memory-calibrated-judges.js";
import { runMemoryCapabilityBenchmark } from "../src/sugent/memory-capability-eval.js";

const MOCK_BYOK_URL = ["http:", "", "127.0.0.1:45199", "v1"].join("/");

describe("Wave P5 Lane F (P5.6): Three-Layer Calibrated Memory Evaluation Flywheel", () => {
  it("1. L1 runMemoryCapabilityBenchmark() runs 72 (>=65) scenarios and satisfies 100% of Wave P5 §4 targets", async () => {
    const report = await runMemoryCapabilityBenchmark();

    expect(report.totalScenarios).toBeGreaterThanOrEqual(68);
    expect(report.totalScenarios).toBe(72);

    // Suite A: 20 queries (12 original + 8 hard bilingual synonym/abbreviation)
    expect(report.suiteA.p4.queryCount).toBe(20);
    expect(report.suiteA.p4.recallAt5).toBeGreaterThanOrEqual(0.99);
    expect(report.suiteA.p4.synonymHardRecallAt5).toBeGreaterThanOrEqual(0.99);
    expect(report.suiteA.p4.mrr).toBeGreaterThanOrEqual(0.95);
    expect(report.suiteA.p4.twoHopRecallAt5).toBe(1);
    expect(report.suiteA.p4.maxNodesRespected).toBe(true);
    expect(report.suiteA.p4.recallAt5).toBeGreaterThan(report.suiteA.baseline.recallAt5);

    // Suite B: 6 supersession chains + 4 E2EE v2 lossless roaming cases = 10 cases
    expect(report.suiteB.p4.caseCount).toBe(10);
    expect(report.suiteB.p4.zombieLeakRate).toBe(0);
    expect(report.suiteB.p4.latestFactTop1Rate).toBe(1);
    expect(report.suiteB.p4.e2eeV2RetentionRate).toBe(1);
    expect(report.suiteB.baseline.e2eeV2RetentionRate).toBe(0);
    expect(report.p5Metrics.e2eeV2RetentionRate).toBe(1);

    // Suite C: 10 feedback turns (6 implicit/euphemistic + 4 explicit) + 10 loyal dissent cases = 20 cases
    expect(report.suiteC.p4.feedbackTurns).toBe(10);
    expect(report.suiteC.p4.implicitFeedbackTurns).toBe(6);
    expect(report.suiteC.p4.implicitFeedbackHitRate).toBeGreaterThanOrEqual(0.9);
    expect(report.suiteC.baseline.implicitFeedbackHitRate).toBe(0);
    expect(report.suiteC.p4.dissentCases).toBe(10);
    expect(report.suiteC.p4.dissentPrecision).toBe(1);
    expect(report.suiteC.p4.dissentRecall).toBe(1);

    // Suite D: 8 cross-surface & full-advisory workflows (Dropzone.handleAdvise + Weixin 3s + Sleep + S0->S3 Provenance)
    expect(report.suiteD.p4.workflowCount).toBe(8);
    expect(report.suiteD.p4.crossSurfaceHitRate).toBe(1);
    expect(report.suiteD.p4.advisoryCrossPlaneHitRate).toBe(1);
    expect(report.suiteD.baseline.advisoryCrossPlaneHitRate).toBe(0);
    expect(report.suiteD.p4.sleepConsolidationPassed).toBe(true);
    expect(report.suiteD.p4.provenanceAclPassed).toBe(true);

    // Suite E: 10 adversarial attacks across M1-M5 x 15 canaries
    expect(report.suiteE.p4Membrane.attackCount).toBe(10);
    expect(report.suiteE.p4Membrane.canaryCount).toBe(15);
    expect(report.suiteE.p4Membrane.canaryLeakRate).toBe(0);
    expect(report.suiteE.p4Membrane.m1ToM5AllSurfacesZeroLeak).toBe(true);
    expect(report.suiteE.naiveSharedBaseline.canaryLeakRate).toBe(1);

    // Suite F: Vector RRF rescue, temporal half-life, M2-M4 symmetric pockets, >7d sandbox expiry
    expect(report.suiteF.p5.caseCount).toBe(4);
    expect(report.suiteF.p5.passRate).toBe(1);
    expect(report.markdownTable).toContain("Wave P5 实测");
  });

  it("2. L2 replayGoldenMemoryTraces() passes all 4 multi-day traces (20 turns) with 0 errors and accurately flags synthetic injected faults across the taxonomy", async () => {
    expect(MEMORY_EVAL_FAILURE_CODES).toEqual([
      "synonym_miss",
      "zombie_resurrection",
      "membrane_side_channel",
      "tone_sycophancy",
      "ungrounded_hallucination",
      "missed_implicit_feedback",
      "premature_conflict_merge",
      "duo_bias_drift",
      "provenance_acl_leak",
    ]);

    const cleanReport = await replayGoldenMemoryTraces();
    expect(cleanReport.totalTraces).toBe(4);
    expect(cleanReport.totalSteps).toBeGreaterThanOrEqual(16);
    expect(cleanReport.failures).toEqual([]);
    expect(cleanReport.passedTraces).toBe(4);
    expect(cleanReport.failedTraces).toBe(0);
    expect(cleanReport.passRate).toBe(1);
    expect(cleanReport.traces.map((t) => t.traceId)).toEqual([
      "trace-contract-5d",
      "trace-eng-incident-4d",
      "trace-weixin-fragments-5d",
      "trace-duo-mediation-5d",
    ]);

    // Verify synthetic fault classification into exact MemoryEvalFailureCode categories
    const zombieReport = await replayGoldenMemoryTraces(undefined, {
      faultInjection: { zombie_resurrection: true },
    });
    expect(zombieReport.failedTraces).toBeGreaterThanOrEqual(1);
    expect(zombieReport.failureTaxonomyCounts.zombie_resurrection).toBeGreaterThanOrEqual(1);

    const membraneReport = await replayGoldenMemoryTraces(undefined, {
      faultInjection: { membrane_side_channel: true },
    });
    expect(membraneReport.failedTraces).toBeGreaterThanOrEqual(1);
    expect(membraneReport.failureTaxonomyCounts.membrane_side_channel).toBeGreaterThanOrEqual(1);

    const sycophancyReport = await replayGoldenMemoryTraces(undefined, {
      faultInjection: { tone_sycophancy: true },
    });
    expect(sycophancyReport.failedTraces).toBeGreaterThanOrEqual(1);
    expect(sycophancyReport.failureTaxonomyCounts.tone_sycophancy).toBeGreaterThanOrEqual(1);

    const implicitMissReport = await replayGoldenMemoryTraces(undefined, {
      faultInjection: { missed_implicit_feedback: true },
    });
    expect(implicitMissReport.failureTaxonomyCounts.missed_implicit_feedback).toBe(1);

    const conflictMergeReport = await replayGoldenMemoryTraces(undefined, {
      faultInjection: { premature_conflict_merge: true },
    });
    expect(conflictMergeReport.failureTaxonomyCounts.premature_conflict_merge).toBe(1);

    const aclLeakReport = await replayGoldenMemoryTraces(undefined, {
      faultInjection: { provenance_acl_leak: true },
    });
    expect(aclLeakReport.failureTaxonomyCounts.provenance_acl_leak).toBeGreaterThanOrEqual(1);
  });

  it("3. L3 dataset split hygiene & buildBinaryJudgePrompt strictly isolate train from dev/test and enforce reasoning-before-verdict", () => {
    const dataset = loadJudgeCalibrationDataset();
    expect(dataset.cases).toHaveLength(66);

    const trainIds = new Set<string>();
    const devIds = new Set<string>();
    const testIds = new Set<string>();

    for (const dim of JUDGE_DIMENSIONS) {
      const dimTrain = dataset.cases.filter((c) => c.dimension === dim && c.split === "train");
      const dimDev = dataset.cases.filter((c) => c.dimension === dim && c.split === "dev");
      const dimTest = dataset.cases.filter((c) => c.dimension === dim && c.split === "test");

      expect(dimTrain).toHaveLength(4);
      expect(dimTrain.filter((c) => c.humanLabel)).toHaveLength(2);
      expect(dimDev).toHaveLength(6);
      expect(dimDev.filter((c) => c.humanLabel)).toHaveLength(3);
      expect(dimTest).toHaveLength(12);
      expect(dimTest.filter((c) => c.humanLabel)).toHaveLength(6);

      for (const c of dimTrain) trainIds.add(c.id);
      for (const c of dimDev) devIds.add(c.id);
      for (const c of dimTest) testIds.add(c.id);

      const prompt = buildBinaryJudgePrompt(dim, dimTrain);
      expect(prompt).toContain("PASS");
      expect(prompt).toContain("FAIL");
      expect(prompt).toContain('"reasoning"');
      expect(prompt).toContain('"verdict"');
      for (const testCase of dimTest) {
        expect(prompt).not.toContain(testCase.id);
      }
    }

    // Global zero overlap across train (12), dev (18), and test (36)
    expect(trainIds.size).toBe(12);
    expect(devIds.size).toBe(18);
    expect(testIds.size).toBe(36);
    for (const id of testIds) {
      expect(trainIds.has(id)).toBe(false);
      expect(devIds.has(id)).toBe(false);
    }

    // Passing a held-out test item into buildBinaryJudgePrompt must throw JUDGE_SPLIT_LEAKAGE
    const heldOutSample = dataset.cases.find((c) => c.split === "test")!;
    expect(() => buildBinaryJudgePrompt("groundedness", [heldOutSample])).toThrow(
      /JUDGE_SPLIT_LEAKAGE/,
    );

    // parseBinaryJudgeResponse checks reasoning-before-verdict ordering
    const validOrdered = parseBinaryJudgeResponse(
      '{"reasoning":"已核对活跃节点48万且无编造","verdict":"PASS"}',
    );
    expect(validOrdered).toEqual({
      verdict: "PASS",
      judgePass: true,
      reasoning: "已核对活跃节点48万且无编造",
      reasoningBeforeVerdict: true,
    });
    const reversedOrder = parseBinaryJudgeResponse(
      '{"verdict":"FAIL","reasoning":"出现了旧价格诈尸"}',
    );
    expect(reversedOrder?.judgePass).toBe(false);
    expect(reversedOrder?.reasoningBeforeVerdict).toBe(false);
    expect(parseBinaryJudgeResponse('{"verdict":"MAYBE","reasoning":"x"}')).toBeNull();
  });

  it("4. L3 statistical calibration & Rogan-Gladen prevalence adjustment compute exact point estimates and 95% CIs", () => {
    const cal = computeBinaryJudgeCalibration([
      { humanLabel: true, judgePass: true },
      { humanLabel: true, judgePass: true },
      { humanLabel: true, judgePass: true },
      { humanLabel: true, judgePass: false }, // 1 FN -> TPR = 3/4 = 0.75
      { humanLabel: false, judgePass: false },
      { humanLabel: false, judgePass: false },
      { humanLabel: false, judgePass: false },
      { humanLabel: false, judgePass: false },
      { humanLabel: false, judgePass: true }, // 1 FP -> TNR = 4/5 = 0.80
    ]);
    expect(cal.total).toBe(9);
    expect(cal.tp).toBe(3);
    expect(cal.fn).toBe(1);
    expect(cal.tn).toBe(4);
    expect(cal.fp).toBe(1);
    expect(cal.tpr).toBe(0.75);
    expect(cal.tnr).toBe(0.8);
    expect(cal.rawPassRate).toBeCloseTo(4 / 9, 4);

    // Known analytical check: TPR = 0.9, TNR = 0.85, rawPassRate = 0.525
    // True prevalence theta = (0.525 + 0.85 - 1) / (0.9 + 0.85 - 1) = 0.375 / 0.75 = 0.5000
    const rg = computeRoganGladenCorrection({
      rawPassRate: 0.525,
      tpr: 0.9,
      tnr: 0.85,
      sampleSize: 100,
      calibrationPositives: 50,
      calibrationNegatives: 50,
    });
    expect(rg.valid).toBe(true);
    expect(rg.correctedPassRate).toBeCloseTo(0.5, 4);
    expect(rg.ci95[0]).toBeGreaterThan(0.3);
    expect(rg.ci95[1]).toBeLessThan(0.7);
    expect(rg.ci95[0]).toBeLessThan(rg.correctedPassRate);
    expect(rg.ci95[1]).toBeGreaterThan(rg.correctedPassRate);

    // Degenerate non-discriminative judge (TPR + TNR <= 1) returns valid: false
    const invalidRg = computeRoganGladenCorrection({
      rawPassRate: 0.5,
      tpr: 0.5,
      tnr: 0.5,
      sampleSize: 20,
      calibrationPositives: 10,
      calibrationNegatives: 10,
    });
    expect(invalidRg.valid).toBe(false);
    expect(invalidRg.ci95).toEqual([0, 1]);
  });

  it("5. L3 runCalibratedMemoryJudges({ split: 'test' }) achieves TPR >= 0.85 & TNR >= 0.85 across all 3 dimensions offline and via live BYOK assessor mock fetch", async () => {
    const offlineTestReport = await runCalibratedMemoryJudges({ split: "test" });
    expect(offlineTestReport.mode).toBe("offline_calibrated_rubric");
    expect(offlineTestReport.zeroTrainSplitLeakage).toBe(true);
    expect(offlineTestReport.allDimensionsPassed).toBe(true);

    for (const dim of JUDGE_DIMENSIONS) {
      const d = offlineTestReport.dimensions[dim];
      expect(d.evaluatedIds).toHaveLength(12);
      expect(d.zeroTrainOverlap).toBe(true);
      expect(d.calibration.tpr).toBeGreaterThanOrEqual(0.85);
      expect(d.calibration.tnr).toBeGreaterThanOrEqual(0.85);
      expect(d.roganGladen.valid).toBe(true);
      expect(d.roganGladen.ci95[0]).toBeLessThanOrEqual(d.roganGladen.correctedPassRate);
      expect(d.roganGladen.ci95[1]).toBeGreaterThanOrEqual(d.roganGladen.correctedPassRate);
      expect(d.meetsGate).toBe(true);
    }

    const offlineDevReport = await runCalibratedMemoryJudges({ split: "dev" });
    expect(offlineDevReport.allDimensionsPassed).toBe(true);

    // Live BYOK assessor routing test (verifying role="assessor" model selection and zero test-label leakage in prompt)
    const dataset = loadJudgeCalibrationDataset();
    const testRationales = dataset.cases
      .filter((c) => c.split === "test")
      .map((c) => c.humanRationale);

    const gwCfg = resolveSugentGatewayConfig(undefined, {
      SUGENT_GATEWAY_MODE: "byok",
      SUGENT_GATEWAY_URL: MOCK_BYOK_URL,
      SUGENT_GATEWAY_KEY: "sk-mock-assessor",
      SUGENT_MODEL_ASSESSOR: "deepseek/assessor-judge-v5",
      SUGENT_MODEL_EXECUTOR: "anthropic/executor-unused",
    });

    const observedModels: string[] = [];
    const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const bodyObj = JSON.parse(String(init?.body ?? "{}")) as {
        model: string;
        messages: Array<{ role: string; content: string }>;
      };
      observedModels.push(bodyObj.model);
      const fullSentText = JSON.stringify(bodyObj.messages);
      // Verify zero test-split humanRationale ever leaked into system or user prompt!
      for (const rationale of testRationales) {
        expect(fullSentText).not.toContain(rationale);
      }

      const userPrompt = bodyObj.messages.find((m) => m.role === "user")?.content ?? "";
      // Simulate calibrated assessor model matching the unlabeled test input to evaluate
      const matchedCase = dataset.cases.find(
        (c) =>
          c.split === "test" &&
          userPrompt.includes(c.userTurn) &&
          userPrompt.includes(c.assistantResponse),
      );
      const verdict = matchedCase?.humanLabel ? "PASS" : "FAIL";
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  reasoning: "Live BYOK assessor evaluated context and rubric criteria.",
                  verdict,
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const liveReport = await runCalibratedMemoryJudges({
      split: "test",
      gatewayConfig: gwCfg,
      fetchImpl: mockFetch,
      preferLiveLlm: true,
    });
    expect(liveReport.mode).toBe("live_byok_assessor");
    expect(liveReport.modelUsed).toBe("deepseek/assessor-judge-v5");
    expect(observedModels).toHaveLength(36);
    expect(new Set(observedModels)).toEqual(new Set(["deepseek/assessor-judge-v5"]));
    expect(liveReport.allDimensionsPassed).toBe(true);

    // Graceful degradation to offline_calibrated_rubric when live endpoint fails
    const brokenLiveReport = await runCalibratedMemoryJudges({
      split: "test",
      gatewayConfig: gwCfg,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED gateway offline");
      }) as typeof fetch,
      preferLiveLlm: true,
    });
    expect(brokenLiveReport.mode).toBe("offline_calibrated_rubric");
    expect(brokenLiveReport.allDimensionsPassed).toBe(true);
  });
});
