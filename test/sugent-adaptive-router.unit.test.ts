import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RoutingExperienceStore } from "../src/sugent/routing-experience-store.js";

describe("RoutingExperienceStore & Policy Directives", () => {
  it("computes Bayesian time-decayed posteriors, detects implicit corrections, and parses NL policy directives", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-exp-"));
    try {
      let nowMs = 1_700_000_000_000;
      const store = new RoutingExperienceStore({
        dataDir: tmp,
        nowMs: () => nowMs,
        halfLifeDays: 14,
        priorStrength: 5,
      });

      for (let i = 0; i < 6; i++) {
        store.recordOutcome({
          decisionId: `d-${i}`,
          targetId: "cliproxy/claude-sonnet-4-6",
          archetype: "coding_and_review",
          ok: true,
          ttftMs: 420,
          totalLatencyMs: 1200,
          costUsd: 0.01,
          signalSource: "turn_complete",
          atMs: nowMs,
        });
        store.recordOutcome({
          decisionId: `b-${i}`,
          targetId: "cliproxy/model-b",
          archetype: "coding_and_review",
          ok: false,
          emptyReply: true,
          signalSource: "quality_escalation",
          atMs: nowMs,
        });
      }
      const pGood = store.getPosterior("coding_and_review", "cliproxy/claude-sonnet-4-6", 0.78, nowMs);
      const pBad = store.getPosterior("coding_and_review", "cliproxy/model-b", 0.78, nowMs);
      expect(pGood.posteriorQuality).toBeGreaterThan(0.88);
      expect(pBad.posteriorQuality).toBeLessThan(0.5);

      nowMs += 28 * 86_400_000; // 2 half-lives: old samples decay by 75%
      const decayed = store.getPosterior("coding_and_review", "cliproxy/model-b", 0.78, nowMs);
      expect(decayed.effectiveSamples).toBeLessThan(3);

      expect(
        store.detectImplicitUserCorrection(
          { userText: "帮我总结今天日报", atMs: nowMs - 20_000 },
          "不对，你没读全重新来",
          nowMs,
        ),
      ).toBe(true);
      expect(
        store.detectImplicitUserCorrection(
          { userText: "帮我记个买牛奶的待办", atMs: nowMs - 20_000 },
          "顺便查下明天天气",
          nowMs,
        ),
      ).toBe(false);
      expect(
        store.detectImplicitUserCorrection(
          { userText: "帮我总结今天日报", atMs: nowMs - 95_000 },
          "不对，你没读全重新来",
          nowMs,
        ),
      ).toBe(false);

      const res = store.applyNaturalLanguageDirective(
        "以后写代码优先用 claude-sonnet-4-6，禁止使用 model-b",
        ["cliproxy/claude-sonnet-4-6", "cliproxy/model-b", "cliproxy/claude-sonnet-4-6-lite"],
      );
      expect(res.matched).toBe(true);
      expect(res.policy.blockedModels).toContain("cliproxy/model-b");
      expect(res.policy.blockedModels).not.toContain("cliproxy/claude-sonnet-4-6");
      expect(res.policy.archetypeBoosts.coding_and_review?.["cliproxy/claude-sonnet-4-6"]).toBeGreaterThan(0);

      // Verify 0o600 atomic persistence under <dataDir>/sugent-routing/
      const expFile = path.join(tmp, "sugent-routing", "routing-experience.json");
      const policyFile = path.join(tmp, "sugent-routing", "routing-policy.json");
      expect(fs.existsSync(expFile)).toBe(true);
      expect(fs.existsSync(policyFile)).toBe(true);
      expect(fs.statSync(expFile).mode & 0o777).toBe(0o600);
      expect(fs.statSync(policyFile).mode & 0o777).toBe(0o600);

      // Verify decision ring buffer + reload persistence
      store.recordDecision({
        decisionId: "rt-1",
        atIso: new Date(nowMs).toISOString(),
        atMs: nowMs,
        archetype: "coding_and_review",
        mode: "auto",
        strategy: "balanced",
        selectedTargetId: "cliproxy/claude-sonnet-4-6",
        rawModelId: "claude-sonnet-4-6",
        providerId: "cliproxy",
        reasonSummary: "test",
        score: 0.91,
        fallbackTargets: [],
        skippedCoolingModels: [],
      });
      store.updateDecisionOutcome("rt-1", { fallbackUsedFrom: "model-b" });

      const reloaded = new RoutingExperienceStore({ dataDir: tmp, nowMs: () => nowMs });
      expect(reloaded.getPolicy().blockedModels).toContain("cliproxy/model-b");
      expect(reloaded.getDecision("rt-1")?.fallbackUsedFrom).toBe("model-b");
      const board = reloaded.getLeaderboardByArchetype(nowMs);
      expect(board.coding_and_review[0]?.targetId).toBe("cliproxy/claude-sonnet-4-6");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

import { ProviderRegistry } from "../src/sugent/provider-registry.js";
import { SugentModelCatalog } from "../src/sugent/model-catalog.js";
import { LocalBudgetLedger } from "../src/sugent/local-budget.js";
import { ModelPoolSyncer } from "../src/sugent/model-pool-sync.js";
import { AdaptiveModelRouter, classifyTaskArchetype } from "../src/sugent/adaptive-router.js";

describe("AdaptiveModelRouter", () => {
  it("classifies 6 archetypes, prunes cooling/blocked/36k-wall models, picks cross-family fallbacks, and shifts via experience", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-router-"));
    try {
      const reg = new ProviderRegistry(tmp);
      reg.upsertProvider({
        id: "cp",
        name: "CLIProxyAPI",
        preset: "custom-openai",
        baseUrl: "http://127.0.0.1:8317/v1",
        apiKey: "sk-1",
        enabled: true,
        setDefault: true,
        models: [
          "gpt-5-nano",
          "gemini-4-argon",
          "claude-sonnet-4-6",
          "gemini-4-hydrogen-xhigh",
        ],
      });
      const catalog = new SugentModelCatalog(tmp);
      const pool = new ModelPoolSyncer({ dataDir: tmp, providers: reg, catalog });
      const exp = new RoutingExperienceStore({ dataDir: tmp });
      const router = new AdaptiveModelRouter({ pool, experience: exp, providers: reg, catalog });

      expect(classifyTaskArchetype({ role: "steward", text: "记个明天买牛奶的待办" }).archetype).toBe("quick_chat_capture");
      expect(classifyTaskArchetype({ role: "steward", text: "回复微信客户来信并安排日程" }).archetype).toBe("tool_orchestration");
      expect(classifyTaskArchetype({ role: "steward", text: "请读取 daily_review.md 完整报告并做深度复盘", historyChars: 65_000 }).archetype).toBe("long_doc_synthesis");
      expect(classifyTaskArchetype({ role: "assessor", text: "为什么这个架构方案需要权衡利弊做长期规划决策" }).archetype).toBe("deep_reasoning_plan");
      expect(classifyTaskArchetype({ role: "executor", text: "重构 TypeScript 路由层并修 bug" }).archetype).toBe("coding_and_review");
      expect(classifyTaskArchetype({ role: "computer_use", text: "看下这张桌面截图点击按钮", hasImages: true }).archetype).toBe("vision_gui");

      // 1. Light task under balanced prefers fast/cheap instead of xhigh
      const quickPlan = router.planRoute({ role: "steward", text: "帮我记个买咖啡的待办", hasTools: true });
      expect(quickPlan?.strategy).toBe("balanced");
      expect(quickPlan?.primary.rawModelId).toBe("gpt-5-nano");
      expect(["frontier", "reasoning"]).toContain(quickPlan?.escalationTarget?.tier);

      // 2. Long context (>70k chars) prunes gemini-4-argon (36k wall) and selects cross-family fallback
      const longPlan = router.planRoute({ role: "steward", text: "完整阅读并总结这份日报", historyChars: 80_000, hasTools: true });
      expect(longPlan?.primary.rawModelId).not.toBe("gemini-4-argon");
      expect(longPlan?.infraFallbacks.some((f) => f.family !== longPlan?.primary.family)).toBe(true);

      // 3. Cooling model skipped on 429
      pool.recordInfraFailure("cp/gpt-5-nano", 429);
      const after429 = router.planRoute({ role: "steward", text: "帮我记个买咖啡的待办", hasTools: true });
      expect(after429?.primary.rawModelId).not.toBe("gpt-5-nano");
      expect(after429?.skippedCoolingModels).toContain("gpt-5-nano");

      // 4. Sustained positive/negative feedback reverses routing order
      for (let i = 0; i < 6; i++) {
        router.recordAttemptOutcome({
          decisionId: `x-${i}`,
          targetId: "cp/claude-sonnet-4-6",
          archetype: "coding_and_review",
          ok: true,
          ttftMs: 300,
          signalSource: "vibe_gate_pass",
        });
        router.recordAttemptOutcome({
          decisionId: `y-${i}`,
          targetId: "cp/gemini-4-hydrogen-xhigh",
          archetype: "coding_and_review",
          ok: false,
          emptyReply: true,
          signalSource: "quality_escalation",
        });
      }
      const codePlan = router.planRoute({ role: "executor", text: "重构 TypeScript 路由层并修 bug", hasTools: true });
      expect(codePlan?.primary.targetId).toBe("cp/claude-sonnet-4-6");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("applies LocalBudgetLedger pressure, controlled exploration, shadow/pinned modes, and dashboard snapshot", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-router-adv-"));
    try {
      const nowMs = 1_700_000_000_000;
      const reg = new ProviderRegistry(tmp);
      reg.upsertProvider({
        id: "cp",
        name: "CLIProxyAPI",
        preset: "custom-openai",
        baseUrl: "http://127.0.0.1:8317/v1",
        apiKey: "sk-1",
        enabled: true,
        setDefault: true,
        defaultModel: "gemini-4-hydrogen-xhigh",
        models: ["gpt-5-nano", "claude-sonnet-4-6", "gemini-4-hydrogen-xhigh"],
      });
      const catalog = new SugentModelCatalog(tmp);
      const pool = new ModelPoolSyncer({ dataDir: tmp, providers: reg, catalog, nowMs: () => nowMs });
      const exp = new RoutingExperienceStore({ dataDir: tmp, nowMs: () => nowMs });
      const budgets = new LocalBudgetLedger(tmp);
      budgets.setBotBudget("default", { enabled: true, limitUsd: 10 }, nowMs);
      budgets.recordUsageCost("default", 9.5, nowMs); // lowReserve + high cost pressure

      const router = new AdaptiveModelRouter({
        pool,
        experience: exp,
        providers: reg,
        catalog,
        localBudgets: budgets,
        nowMs: () => nowMs,
      });

      // Controlled exploration active for low-risk when archetype has prior samples
      for (let i = 0; i < 6; i++) {
        exp.recordOutcome({
          decisionId: `q-${i}`,
          targetId: "cp/gpt-5-nano",
          archetype: "quick_chat_capture",
          ok: true,
          signalSource: "turn_complete",
          atMs: nowMs,
        });
      }
      const lowRiskPlan = router.planRoute({ role: "steward", text: "记个待办", botId: "default" });
      const underExploredScore = lowRiskPlan?.scoredCandidates.find((c) => c.targetId === "cp/claude-sonnet-4-6");
      expect(underExploredScore?.exploreBonus).toBeGreaterThan(0);

      // High-risk archetype disables exploration bonus
      const highRiskPlan = router.planRoute({ role: "executor", text: "修复 TypeScript 源码 bug", botId: "default" });
      expect(highRiskPlan?.scoredCandidates.every((c) => c.exploreBonus === 0)).toBe(true);

      // Budget pressure drives quick task toward fast/low-cost model even harder
      expect(lowRiskPlan?.primary.rawModelId).toBe("gpt-5-nano");

      // Shadow mode keeps defaultModel as primary, sets shadowRecommendedTargetId
      exp.updatePolicy({ mode: "shadow" });
      const shadowPlan = router.planRoute({ role: "steward", text: "帮我记个买牛奶的待办" });
      expect(shadowPlan?.mode).toBe("shadow");
      expect(shadowPlan?.primary.rawModelId).toBe("gemini-4-hydrogen-xhigh");
      expect(shadowPlan?.shadowRecommendedTargetId).toBe("cp/gpt-5-nano");

      // Pinned mode forces pinnedModel
      exp.updatePolicy({ mode: "pinned", pinnedModel: "cp/claude-sonnet-4-6" });
      const pinnedPlan = router.planRoute({ role: "steward", text: "帮我记个买牛奶的待办" });
      expect(pinnedPlan?.primary.targetId).toBe("cp/claude-sonnet-4-6");

      router.recordVibeGateFeedback(true, "cp/claude-sonnet-4-6", pinnedPlan?.decisionId);
      const dash = router.getDashboardSnapshot();
      expect(dash.mode).toBe("pinned");
      expect(dash.pool.chatModels).toBe(3);
      expect(dash.recentDecisions.length).toBeGreaterThanOrEqual(4);
      expect(dash.leaderboard.coding_and_review[0]?.targetId).toBe("cp/claude-sonnet-4-6");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("downgrades frontier to balanced when LocalBudgetLedger is exhausted and uses fallback endpoint when pool is empty", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-router-budget-"));
    try {
      const nowMs = 1_700_000_000_000;
      const reg = new ProviderRegistry(tmp);
      reg.upsertProvider({
        id: "cp",
        preset: "custom-openai",
        baseUrl: "http://127.0.0.1:8317/v1",
        apiKey: "sk-1",
        enabled: true,
        setDefault: true,
        models: ["gpt-4.1-mini", "claude-sonnet-4-6"],
      });
      const catalog = new SugentModelCatalog(tmp);
      const pool = new ModelPoolSyncer({ dataDir: tmp, providers: reg, catalog, nowMs: () => nowMs });
      const exp = new RoutingExperienceStore({ dataDir: tmp, nowMs: () => nowMs });
      const budgets = new LocalBudgetLedger(tmp);
      budgets.setBotBudget("default", { enabled: true, limitUsd: 10 }, nowMs);
      const router = new AdaptiveModelRouter({
        pool,
        experience: exp,
        providers: reg,
        catalog,
        localBudgets: budgets,
        getFallbackEndpoint: () => ({ baseUrl: "http://127.0.0.1:11434/v1", apiKey: "local", model: "qwen2.5:7b" }),
        nowMs: () => nowMs,
      });

      const healthyBudgetPlan = router.planRoute({ role: "assessor", text: "为什么这个架构方案需要权衡利弊做决策", botId: "default" });
      expect(healthyBudgetPlan?.primary.rawModelId).toBe("claude-sonnet-4-6");

      budgets.recordUsageCost("default", 12, nowMs); // exhausted -> costMult = 2.0
      const exhaustedPlan = router.planRoute({ role: "assessor", text: "为什么这个架构方案需要权衡利弊做决策", botId: "default" });
      expect(exhaustedPlan?.primary.rawModelId).toBe("gpt-4.1-mini");

      const fallbackPlan = router.planRoute({
        role: "steward",
        text: "记个待办",
        excludeTargetIds: ["cp/gpt-4.1-mini", "cp/claude-sonnet-4-6"],
      });
      expect(fallbackPlan?.primary.rawModelId).toBe("qwen2.5:7b");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
