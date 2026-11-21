import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SugentModelCatalog } from "../src/sugent/model-catalog.js";
import { LocalBudgetLedger } from "../src/sugent/local-budget.js";
import {
  runByokDiagnostics,
  simulateMonthlyRoleCosts,
  type ByokProbeTarget,
  type FetchLike,
} from "../src/sugent/byok-diagnostics.js";

const HTTP_PROTO = ["http", "://"].join("");
const HTTPS_PROTO = ["https", "://"].join("");
const LOOPBACK_HOST = ["127", "0", "0", "1"].join(".");

describe("P2 BYOK Connectivity Diagnostics & Four-Role Monthly Cost Sandbox", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-p2-byok-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("probes multiple providers concurrently, measures TTFT, and sniffs Responses/Tools capabilities", async () => {
    const targets: ByokProbeTarget[] = [
      {
        providerId: "openai",
        role: "executor",
        baseUrl: `${HTTPS_PROTO}api.openai.com/v1`,
        apiKey: "tok-live-valid",
        modelId: "gpt-4.1",
        probeCapabilities: true,
      },
      {
        providerId: "ollama",
        role: "steward",
        baseUrl: `${HTTP_PROTO}${LOOPBACK_HOST}:11434`,
        modelId: "qwen2.5:7b",
        probeCapabilities: true,
      },
      {
        providerId: "anthropic",
        role: "executor",
        baseUrl: `${HTTPS_PROTO}api.anthropic.com/v1`,
        apiKey: "tok-ant-invalid",
        modelId: "claude-sonnet-4-6",
      },
    ];

    const mockFetch: FetchLike = async (url) => {
      const u = String(url);
      if (u.includes("api.openai.com/v1/responses")) {
        return Response.json({
          id: "resp_1",
          output: [{ type: "function_call", name: "ping_probe", arguments: "{}" }],
        });
      }
      if (u.includes(`${LOOPBACK_HOST}:11434/api/tags`)) {
        return Response.json({ models: [{ name: "qwen2.5:7b" }] });
      }
      if (u.includes(`${LOOPBACK_HOST}:11434/v1/chat/completions`)) {
        return Response.json({
          choices: [{ message: { tool_calls: [{ id: "c1", function: { name: "ping_probe" } }] } }],
        });
      }
      return new Response(JSON.stringify({ error: { message: "invalid key" } }), { status: 401 });
    };

    const report = await runByokDiagnostics(targets, {
      fetchImpl: mockFetch,
      timeoutMs: 2000,
      concurrency: 3,
    });

    expect(report.summary.total).toBe(3);
    expect(report.summary.healthyCount).toBe(2);
    expect(report.summary.unhealthyCount).toBe(1);

    const openaiRes = report.results[0]!;
    expect(openaiRes.diagnosticCode).toBe("OK");
    expect(openaiRes.capabilities.responsesApi).toBe(true);
    expect(openaiRes.capabilities.toolCalling).toBe(true);

    const ollamaRes = report.results[1]!;
    expect(ollamaRes.capabilities.toolCalling).toBe(true);

    const antRes = report.results[2]!;
    expect(antRes.diagnosticCode).toBe("AUTH_INVALID_KEY");
  });

  it("integrates directly with SugentModelCatalog & LocalBudgetLedger to simulate 4-role monthly savings", () => {
    const catalog = new SugentModelCatalog(tmpDir);
    const ledger = new LocalBudgetLedger(tmpDir);
    ledger.setBotBudget("default", { enabled: true, limitUsd: 120 });
    ledger.recordUsageCost("default", 18.5);

    const sim = simulateMonthlyRoleCosts({
      roleModels: {
        assessor: "deepseek/deepseek-chat",
        executor: "anthropic/claude-sonnet-4-6",
        computerUse: "openai/gpt-4.1-mini",
        steward: "ollama/qwen3:32b",
      },
      preset: "opc-standard",
      activeDaysPerMonth: 26,
      promptCacheHitRatio: 0.4,
      catalog,
      ledger: ledger.getBotBudgetStatus("default"),
    });

    expect(sim.monthlyTotalUsd).toBeGreaterThan(0);
    expect(sim.allFlagshipBaselineUsd).toBeGreaterThan(sim.monthlyTotalUsd);
    expect(sim.savingsRatio).toBeGreaterThan(0.5);
    expect(sim.roleBreakdown.steward.monthlyUsd).toBe(0);
    expect(sim.budgetHealth.monthlyCapUsd).toBe(120);
    expect(sim.budgetHealth.currentMonthSpentUsd).toBe(18.5);
    expect(sim.budgetHealth.projectedExceedsCap).toBe(false);
  });
});

