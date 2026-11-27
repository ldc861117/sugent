import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import {
  AdaptiveModelRouter,
  LocalBudgetLedger,
  ModelPoolSyncer,
  ProviderRegistry,
  RoutingExperienceStore,
  StewardLlmAgent,
  SugentKnowledgeGraph,
  SugentModelCatalog,
  SugentStewardHostService,
} from "../src/sugent/index.js";
import type { StewardWorkbenchLike } from "../src/sugent/steward-conversation.js";

const stubWb = (): StewardWorkbenchLike => ({
  callerDomain: "owner_private",
  quietHoursActive: false,
  ledger: { version: 1, updatedAt: "", relationships: [], goals: [], guardrails: [], commitments: [], resources: [] },
  cadence: { dateKey: "2026-11-23", state: { nonUrgentSentCount: 0, dailySoftQuota: 0, morningDigestQueue: [] } },
  antigravity: { surfacesScanned: [], totalSessions: 0, totalSubagentsFolded: 0, sessions: [], projects: [] },
});

const stubToolsPort = () => ({
  getWorkbench: stubWb,
  queryLedger: () => ({ goals: [], commitments: [], guardrails: [], relationships: [], resources: [], ledgerSummary: "" }),
  findArchiveResources: () => [],
  upsertArchiveResource: () => [],
  mutateCommitment: () => ({ ok: true as const, commitment: {} as never, workbench: stubWb() }),
  mutateGoal: () => ({ ok: true, workbench: stubWb() }),
  mutateTrust: () => ({ ok: true, workbench: stubWb() }),
  submitDropzone: async () => ({ ok: true as const, outcome: {} as never, workbench: stubWb() }),
  scanCadence: () => ({ emitNow: [], foldToMorningDigest: [], workbench: stubWb() }),
  setQuietHours: () => ({ quietHoursActive: false, workbench: stubWb() }),
  setProjectTier: () => ({ workbench: stubWb() }),
  markSessionViewed: () => ({ workbench: stubWb() }),
  comprehendSession: async () => ({} as never),
  dispatchAntigravity: async () => ({} as never),
});

describe("StewardLlmAgent Cascade, Intra-Turn Stickiness & Legacy Compat", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("supports legacy getEndpoint() without resolveRoutePlan and accumulates usage across rounds", async () => {
    let usageSum = 0;
    const agent = new StewardLlmAgent({
      getEndpoint: () => ({ baseUrl: "http://127.0.0.1:43199/v1", apiKey: "legacy-k", model: "legacy-model" }),
      recordUsageUsd: (u) => { usageSum += u; },
      fetchImpl: async () => new Response(JSON.stringify({
        model: "legacy-model",
        usage: { prompt_tokens: 1000, completion_tokens: 100 },
        choices: [{ message: { role: "assistant", content: "legacy ok" } }],
      }), { status: 200 }),
      toolsPort: stubToolsPort(),
    });
    const out = await agent.runTurn({ text: "hello" });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.modelUsed).toBe("legacy-model");
      expect(out.reply).toBe("legacy ok");
    }
    expect(usageSum).toBeCloseTo((1000 * 3 + 100 * 15) / 1_000_000, 8);
  });
  it("silently fails over on 429, escalates Round 0 empty replies, locks thought_signature mid-loop, and accounts usage on both Round 0 & Rounds 1-4", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-agent-rt-"));
    dirs.push(tmp);
    const reg = new ProviderRegistry(tmp);
    reg.upsertProvider({ id: "cp", preset: "custom-openai", baseUrl: "http://127.0.0.1:8317/v1", apiKey: "k", enabled: true, setDefault: true, models: ["gpt-5-nano", "gemini-4-hydrogen-xhigh", "claude-sonnet-4-6"] });
    const catalog = new SugentModelCatalog(tmp);
    const pool = new ModelPoolSyncer({ dataDir: tmp, providers: reg, catalog });
    const exp = new RoutingExperienceStore({ dataDir: tmp });
    const router = new AdaptiveModelRouter({ pool, experience: exp, providers: reg, catalog });

    const calls: Array<{ model: string; hasThoughtSig: boolean }> = [];
    let forceEmptyNano = false;
    let recordedUsd = 0;
    const mockFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model: string; messages: Array<{ tool_calls?: Array<{ extra_content?: { google?: { thought_signature?: string } } }> }> };
      const hasSig = body.messages.some((m) => m.tool_calls?.some((tc) => tc.extra_content?.google?.thought_signature === "sig-g4"));
      calls.push({ model: body.model, hasThoughtSig: hasSig });
      if (body.model === "gpt-5-nano") {
        return forceEmptyNano
          ? new Response(JSON.stringify({ model: body.model, choices: [{ message: { role: "assistant", content: "   " } }] }), { status: 200 })
          : new Response("rate limit", { status: 429 });
      }
      if (body.model === "gemini-4-hydrogen-xhigh" && !hasSig) {
        return new Response(JSON.stringify({ model: body.model, usage: { prompt_tokens: 1000, completion_tokens: 100 }, choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "tc-1", type: "function", function: { name: "query_personal_memory", arguments: "{\"query\":\"test\"}" }, extra_content: { google: { thought_signature: "sig-g4" } } }] } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ model: body.model, usage: { prompt_tokens: 2000, completion_tokens: 200 }, choices: [{ message: { role: "assistant", content: "已完成查询。" } }] }), { status: 200 });
    };
    const agent = new StewardLlmAgent({
      getEndpoint: () => undefined,
      fetchImpl: mockFetch,
      recordUsageUsd: (u) => { recordedUsd += u; },
      resolveRoutePlan: (ctx) => router.planRoute(ctx),
      estimateCostUsd: (m, u) => catalog.estimateCostUsd(m, u),
      onRouteAttemptOutcome: (ev) => router.recordAttemptOutcome(ev),
      toolsPort: {
        ...stubToolsPort(),
        getRoutingDashboard: () => router.getDashboardSnapshot(),
        updateRoutingPolicy: (patch) => ({ matched: true, policy: exp.updatePolicy(patch) }),
      },
    });
    // 1) 429 failover on Round 0
    const quickOut = await agent.runTurn({ text: "帮我记个买咖啡的待办" });
    expect(quickOut.ok).toBe(true);
    if (quickOut.ok) expect(quickOut.routeMeta?.fallbackFrom).toBe("gpt-5-nano");

    // 2) Quality escalation on Round 0 empty reply
    pool.recordInfraSuccess("cp/gpt-5-nano");
    forceEmptyNano = true;
    const escOut = await agent.runTurn({ text: "记个明天取快递的待办" });
    expect(escOut.ok).toBe(true);
    if (escOut.ok) {
      expect(escOut.routeMeta?.escalatedFrom).toBe("gpt-5-nano");
      expect(escOut.modelUsed).not.toBe("gpt-5-nano");
    }

    // 3) Intra-turn Gemini thought_signature lock + Round 0 & Round 1 usage accounting
    recordedUsd = 0;
    exp.applyNaturalLanguageDirective("在 规划 中优先使用 gemini-4-hydrogen-xhigh", ["cp/gemini-4-hydrogen-xhigh"]);
    const out = await agent.runTurn({ text: "帮我规划系统架构并查记忆" });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(calls.at(-1)?.model).toBe("gemini-4-hydrogen-xhigh");
      expect(calls.at(-1)?.hasThoughtSig).toBe(true);
    }
    const r0Usd = catalog.estimateCostUsd("gemini-4-hydrogen-xhigh", { inputTokens: 1000, outputTokens: 100 });
    const r1Usd = catalog.estimateCostUsd("gemini-4-hydrogen-xhigh", { inputTokens: 2000, outputTokens: 200 });
    expect(recordedUsd).toBeCloseTo(r0Usd + r1Usd, 8);
  });
});

describe("StewardHostService Adaptive Routing Integration", () => {
  it("supports CLIProxyAPI sync, manage_model_routing tool, 90s implicit correction, retryLastTurnStronger, and zero KG writes", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-host-rt-"));
    try {
      const reg = new ProviderRegistry(tmp);
      reg.upsertProvider({ id: "cp", preset: "custom-openai", baseUrl: "http://127.0.0.1:8317/v1", apiKey: "k", enabled: true, setDefault: true });
      const kg = new SugentKnowledgeGraph(path.join(tmp, "kg"));
      const catalog = new SugentModelCatalog(tmp);
      let triggerToolCall = false;
      const mockFetch: typeof fetch = async (url, init) => {
        if (String(url).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [{ id: "gpt-5-nano" }, { id: "claude-sonnet-4-6" }, { id: "gemini-4-hydrogen-xhigh" }, { id: "text-embedding-3-small" }] }), { status: 200 });
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as { model: string; messages: Array<{ role: string; content?: string }> };
        if (triggerToolCall && !body.messages.some((m) => m.role === "tool")) {
          return new Response(JSON.stringify({ model: body.model, choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "rt-tool-1", type: "function", function: { name: "manage_model_routing", arguments: JSON.stringify({ action: "set_policy", strategy: "quality_first" }) } }] } }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ model: body.model, usage: { prompt_tokens: 400, completion_tokens: 80 }, choices: [{ message: { role: "assistant", content: `reply by ${body.model}` } }] }), { status: 200 });
      };
      const svc = new SugentStewardHostService({ dataDir: tmp, homeDir: tmp, knowledgeGraph: kg, localBudgets: new LocalBudgetLedger(tmp), providerRegistry: reg, modelCatalog: catalog, llmFetch: mockFetch });
      const syncRes = await svc.syncModelPool({ providerId: "cp", force: true });
      expect(syncRes[0]?.chatModelCount).toBe(3);
      expect(kg.allNodes()).toHaveLength(0);

      const t1 = await svc.converse({ text: "帮我记个买菜待办" });
      expect(t1.modelUsed).toBe("gpt-5-nano");

      // 90s implicit correction triggers user_correction penalty
      await svc.converse({ text: "不对，漏了明细重新来" });
      const expCell = svc.routingExperience.getPosterior("quick_chat_capture", "cp/gpt-5-nano", 0.65);
      expect(expCell.effectiveSamples).toBeGreaterThanOrEqual(2);

      const retry = await svc.retryLastTurnStronger("owner_private");
      expect(retry.ok).toBe(true);
      expect(retry.modelUsed).not.toBe("gpt-5-nano");

      // manage_model_routing tool switches strategy to quality_first
      triggerToolCall = true;
      const toolTurn = await svc.converse({ text: "帮我把路由切到质量优先" });
      expect(toolTurn.toolCallsExecuted).toContain("manage_model_routing");
      expect(svc.getRoutingDashboard().strategy).toBe("quality_first");
      expect(kg.allNodes()).toHaveLength(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("Steward & Provider Adaptive Routing HTTP API", () => {
  it("exposes /providers/sync-models and /steward/routing/* endpoints end-to-end without blocking or writing KG nodes", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-web-rt-"));
    const app = new App(loadConfig({ dataDir: tmp, env: { AMB_MAGPIE_BASE_URL: "http://127.0.0.1:43199/v1", AMB_AGENT: "off", AMB_UI_PORT: "0", AMB_WEIXIN_API_BASE: "http://127.0.0.1:9" } }), { printQrToTerminal: false, fileLog: false });
    await app.start();
    const callApi = async (pathname: string, method = "GET", body?: unknown) => {
      const res = await app.web!.inject(`/amb/api${pathname}`, {
        method,
        headers: body !== undefined ? { "content-type": "application/json" } : {},
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: res.text ? JSON.parse(res.text) : {} };
    };
    try {
      app.desktop = {
        autostart: () => ({ supported: false, on: false }),
        setAutostart: () => {},
        applyZoom: () => {},
        openDataDir: () => {},
        openInBrowser: () => {},
        openExternal: () => {},
        fetch: async (url, init) => {
          if (String(url).endsWith("/models")) {
            return new Response(JSON.stringify({ data: [{ id: "gpt-5-nano" }, { id: "claude-sonnet-4-6" }, { id: "text-embedding-3-small" }] }), { status: 200 });
          }
          const body = JSON.parse(String(init?.body ?? "{}")) as { model: string };
          return new Response(JSON.stringify({ model: body.model, usage: { prompt_tokens: 200, completion_tokens: 40 }, choices: [{ message: { role: "assistant", content: `ok:${body.model}` } }] }), { status: 200 });
        },
      };
      await app.upsertDecoupledProvider({ id: "cp", preset: "custom-openai", baseUrl: "http://127.0.0.1:8317/v1", apiKey: "k", setDefault: true });

      const syncProviders = await callApi("/providers/sync-models", "POST", { providerId: "cp", force: true });
      expect(syncProviders.status).toBe(200);
      expect(syncProviders.json.ok).toBe(true);
      expect(syncProviders.json.results[0].chatModelCount).toBe(2);

      const rtGet = await callApi("/steward/routing");
      expect(rtGet.status).toBe(200);
      expect(rtGet.json.strategy).toBe("balanced");
      expect(rtGet.json.pool.chatModels).toBe(2);

      const polPut = await callApi("/steward/routing/policy", "PUT", { strategy: "quality_first", mode: "shadow" });
      expect(polPut.status).toBe(200);
      expect(polPut.json.policy).toMatchObject({ strategy: "quality_first", mode: "shadow" });
      await callApi("/steward/routing/policy", "PUT", { strategy: "balanced", mode: "auto" });

      const rtSync = await callApi("/steward/routing/sync", "POST", { force: true });
      expect(rtSync.status).toBe(200);
      expect(rtSync.json.ok).toBe(true);

      const emptyRetry = await callApi("/steward/routing/retry-stronger", "POST", {});
      expect(emptyRetry.status).toBe(200);
      expect(emptyRetry.json).toMatchObject({ ok: false, errorCode: "NO_PREVIOUS_TURN" });

      const conv = await callApi("/steward/converse", "POST", { text: "记个明天交电费的待办" });
      expect(conv.status).toBe(200);
      expect(conv.json.modelUsed).toBe("gpt-5-nano");

      const stronger = await callApi("/steward/routing/retry-stronger", "POST", {});
      expect(stronger.status).toBe(200);
      expect(stronger.json.ok).toBe(true);
      expect(stronger.json.modelUsed).toBe("claude-sonnet-4-6");

      const wb = await callApi("/steward/workbench?domain=owner_private");
      expect(wb.json.routing.recentDecisions.length).toBeGreaterThanOrEqual(2);
      expect(app.knowledgeGraph.allNodes()).toHaveLength(0);
    } finally {
      await app.stop();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("Vibe Gate Feedback & Offline Startup Sync Tolerance", () => {
  it("records vibe_gate_pass on verify_now and boots App non-blockingly when upstream is ECONNREFUSED", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-vibe-off-"));
    try {
      const reg = new ProviderRegistry(tmp);
      reg.upsertProvider({ id: "cp", preset: "custom-openai", baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", enabled: true, setDefault: true, models: ["claude-sonnet-4-6"] });
      const svc = new SugentStewardHostService({
        dataDir: tmp,
        homeDir: tmp,
        knowledgeGraph: new SugentKnowledgeGraph(path.join(tmp, "kg")),
        localBudgets: new LocalBudgetLedger(tmp),
        providerRegistry: reg,
        vibeCommandRunner: async () => ({ exitCode: 0, outputTail: "ok" }),
        agentApiRunner: {
          async getConversationMetadata() { return { exists: true, nestingDepth: 0 }; },
          async sendMessage() { return { ok: true, exitCode: 0 }; },
          async newConversation() { return { conversationId: "00000000-0000-4000-8000-000000000001", exitCode: 0 }; },
        },
      });
      svc.adaptiveRouter.planRoute({ role: "executor", text: "修复 TypeScript 编译错误" });
      const repoDir = path.join(tmp, "repo");
      fs.mkdirSync(repoDir, { recursive: true });
      svc.upsertRepoBinding({ alias: "demo", repoRoot: repoDir, verifyArgv: ["echo", "ok"], restartMode: "none" });
      await svc.startVibeTask({ text: "实现小功能", bindingQuery: "demo", useWorktree: false });
      const pipe = svc.vibePipeline.listPipelines()[0]!;
      const res = await svc.decideVibeTask({ pipelineId: pipe.pipelineId, action: "verify_now" });
      expect(res.ok).toBe(true);
      expect(svc.routingExperience.getPosterior("coding_and_review", "cp/claude-sonnet-4-6", 0.88).effectiveSamples).toBeGreaterThanOrEqual(2);

      const t0 = Date.now();
      const app = new App(loadConfig({ dataDir: tmp, env: { AMB_MAGPIE_BASE_URL: "http://127.0.0.1:43199/v1", AMB_AGENT: "off", AMB_UI_PORT: "0", AMB_WEIXIN_API_BASE: "http://127.0.0.1:9" } }), { printQrToTerminal: false, fileLog: false });
      await app.start();
      expect(Date.now() - t0).toBeLessThan(3000);
      await app.stop();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
