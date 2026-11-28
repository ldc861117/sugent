import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { runMemoryCapabilityBenchmark } from "../src/sugent/index.js";

const MOCK_API_BASE = ["http:", "", "127.0.0.1:43199", "v1"].join("/");
const MOCK_WEIXIN_BASE = ["http:", "", "127.0.0.1:9"].join("/");

async function createEvalHostApp(tag: string) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `sugent-eval-${tag}-`));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `sugent-eval-home-${tag}-`));
  const cfg = loadConfig({
    dataDir,
    env: {
      AMB_MAGPIE_BASE_URL: MOCK_API_BASE,
      AMB_UI_PORT: "0",
      AMB_AGENT: "off",
      AMB_WEIXIN_API_BASE: MOCK_WEIXIN_BASE,
    },
  });
  const app = new App(cfg, { noWeb: false, fileLog: false, printQrToTerminal: false, stewardHomeDir: homeDir });
  await app.start();
  return {
    app,
    dataDir,
    homeDir,
    cleanup: async () => {
      await app.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

describe("Wave P4 Quantitative Capability Benchmark & Multi-Day Host Lifecycle", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it("proves measurable RAG & security lift over Baseline across 65+ controlled scenarios", async () => {
    const report = await runMemoryCapabilityBenchmark();

    expect(report.totalScenarios).toBeGreaterThanOrEqual(65);
    expect(report.suiteA.p4.recallAt5).toBeGreaterThanOrEqual(0.99);
    expect(report.suiteA.p4.mrr).toBeGreaterThan(report.suiteA.baseline.mrr);
    expect(report.suiteA.p4.ndcgAt5).toBeGreaterThan(report.suiteA.baseline.ndcgAt5);
    expect(report.suiteA.p4.twoHopRecallAt5).toBe(1);
    expect(report.suiteA.p4.maxNodesRespected).toBe(true);
    expect(report.suiteA.baseline.maxNodesRespected).toBe(false);

    expect(report.suiteB.p4.zombieLeakRate).toBe(0);
    expect(report.suiteB.p4.latestFactTop1Rate).toBe(1);
    expect(report.suiteB.p4.e2eeV2RetentionRate).toBe(1);
    expect(report.p5Metrics.e2eeV2RetentionRate).toBe(1);
    expect(report.suiteB.baseline.zombieLeakRate).toBeGreaterThan(0.5);

    expect(report.suiteC.p4.selfCorrectionHitRate).toBe(1);
    expect(report.suiteC.p4.implicitFeedbackHitRate).toBeGreaterThanOrEqual(0.9);
    expect(report.p5Metrics.implicitFeedbackHitRate).toBeGreaterThanOrEqual(0.9);
    expect(report.suiteC.baseline.selfCorrectionHitRate).toBe(0);
    expect(report.suiteC.p4.dissentRecall).toBe(1);
    expect(report.suiteC.p4.dissentPrecision).toBe(1);

    expect(report.suiteD.p4.crossSurfaceHitRate).toBe(1);
    expect(report.suiteD.p4.advisoryCrossPlaneHitRate).toBe(1);
    expect(report.p5Metrics.advisoryCrossPlaneHitRate).toBe(1);
    expect(report.suiteD.p4.briefDomainWorkCount).toBeGreaterThan(0);

    expect(report.suiteE.p4Membrane.canaryLeakRate).toBe(0);
    expect(report.suiteE.naiveSharedBaseline.canaryLeakRate).toBe(1);
    expect(report.suiteE.p4Membrane.contextUtilityScore).toBeGreaterThan(
      report.suiteE.isolatedBaseline.contextUtilityScore,
    );
  });

  it("closes a full 5-day App lifecycle: ContractGuard + PostTurn -> Feedback Tombstone -> Tool Recall -> Duo M1", async () => {
    const ctx = await createEvalHostApp("multiday");
    cleanups.push(ctx.cleanup);

    // Day 1: Seed redline + ContractGuard pack + Duo commitment + Sugent sandbox judgment
    ctx.app.stewardService.ledger.addGuardrail({
      partition: "work_project",
      kind: "hard_redline",
      statement: "ProjectOmegaSecret 单价底线不得低于 50 万元人民币，付款账期上限 30 天",
    });
    ctx.app.stewardService.ledger.upsertResource({
      partition: "work_project",
      kind: "budget_cap",
      title: "Omega 采购历史底价与账期",
      metadata: { counterparty: "Omega 采购", floorPrice: 500000, maxPaymentDays: 30 },
    });
    const contractCard = ctx.app.stewardService.runContractGuardPack({
      inquiryId: "inq-day1-omega",
      counterparty: "Omega 采购",
      rawContractText: "对方要求采购单价 38 万元，净账期 Net 90 天，并包含无限连带责任。",
      quotedUnitPrice: 380000,
      requestedPaymentDays: 90,
    });
    expect(contractCard.verdict).toBe("block");

    ctx.app.stewardService.mindLoop.recordJudgment({
      topicKey: "omega-net90-pitch",
      surface: "im_owner",
      hypothesis: "对 Omega 采购可先让步账期换取首单落地",
      rationale: "Day 1 试探策略",
    });

    // Day 3: Owner tells Sugent in /steward/converse that the Day-1 pitch failed -> auto-tombstoned before turn runs!
    let toolObservedResult = "";
    let capturedDuoSystemPrompt = "";
    const origFetch = globalThis.fetch;
    let callIdx = 0;
    ctx.app.desktop = {
      autostart: () => ({ supported: false, on: false }),
      setAutostart: () => {},
      applyZoom: () => {},
      openDataDir: () => {},
      openInBrowser: () => {},
      openExternal: () => {},
      fetch: (async (url, init) => {
        if (String(url).includes("chat/completions")) {
          callIdx++;
          const bodyStr = String(init?.body ?? "");
          if (bodyStr.includes("星轨幕僚")) {
            capturedDuoSystemPrompt = bodyStr;
            return new Response(
              JSON.stringify({ model: "mock-duo", choices: [{ message: { role: "assistant", content: "先安心休息，明日再温柔沟通。" } }] }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          if (callIdx === 1) {
            return new Response(
              JSON.stringify({
                model: "mock-steward",
                choices: [{
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [{ id: "tc-1", type: "function", function: { name: "query_personal_memory", arguments: JSON.stringify({ query: "Omega" }) } }],
                  },
                }],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          const parsedBody = JSON.parse(bodyStr) as { messages?: Array<{ role: string; content: string }> };
          const toolMsg = parsedBody.messages?.find((m) => m.role === "tool")?.content ?? "";
          if (toolMsg) toolObservedResult = toolMsg;
          return new Response(
            JSON.stringify({ model: "mock-steward", choices: [{ message: { role: "assistant", content: "已记住避坑：严禁让步 Omega Net 90 账期。" } }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return origFetch(url, init);
      }) as typeof fetch,
    };
    ctx.app.providers.upsertProvider({
      id: "eval-mock",
      name: "EvalMock",
      preset: "custom-openai",
      baseUrl: MOCK_API_BASE,
      apiKey: "sk-eval-mock",
      defaultModel: "deepseek/deepseek-chat",
      models: ["deepseek/deepseek-chat"],
      enabled: true,
    });
    ctx.app.providers.setDefaultProvider("eval-mock");
    ctx.app.providers.setRoleRouting({ steward: "deepseek/deepseek-chat", executor: "deepseek/deepseek-chat" });

    const convRes = await ctx.app.web!.inject("/amb/api/steward/converse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "上次对 Omega 让步账期的建议翻车失败了，再帮我查下 Omega 审校与教训", callerDomain: "owner_private" }),
    });
    expect(convRes.status).toBe(200);
    expect(toolObservedResult).toContain("domain_work:contract-guard");
    expect(toolObservedResult).toContain("self_core");

    // Day 5: Duo partner queries weather via /steward/duo/converse -> M1 zero confidential canary leak
    const duoRes = await ctx.app.web!.inject("/amb/api/steward/duo/converse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spaceId: "andy-gillna", speaker: "W", messages: [{ role: "user", content: "他最近工作顺不顺，我需要注意什么？" }] }),
    });
    expect(duoRes.status).toBe(200);
    expect(capturedDuoSystemPrompt).toContain("伴侣近期星轨天气胶囊");
    expect(capturedDuoSystemPrompt).not.toContain("ProjectOmegaSecret");
    expect(capturedDuoSystemPrompt).not.toContain("Omega");
    expect(duoRes.text).not.toContain("ProjectOmegaSecret");
    expect(duoRes.text).not.toContain("Omega");
  });
});
