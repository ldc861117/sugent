import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalBudgetLedger } from "../src/sugent/local-budget.js";
import {
  SugentModelCatalog,
  resolveBuiltinModelInfo,
} from "../src/sugent/model-catalog.js";
import {
  LLM_PROVIDER_PRESETS,
  ProviderRegistry,
  deriveMagpieApiBases,
} from "../src/sugent/provider-registry.js";

const HTTP_PROTO = ["http", "://"].join("");
const LOOPBACK_OLLAMA = `${HTTP_PROTO}127.0.0.1:11434/v1`;
const LOOPBACK_COWORK = `${HTTP_PROTO}127.0.0.1:28080/v1`;
const LOOPBACK_GW_A = `${HTTP_PROTO}127.0.0.1:18080/v1`;
const LOOPBACK_GW_B = `${HTTP_PROTO}127.0.0.1:19090/v1`;

describe("Sugent ProviderRegistry, ModelCatalog & LocalBudgetLedger", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-unit-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("ProviderRegistry", () => {
    it("exposes clean preset defaults without tracking parameters and marks ollama as keyless", () => {
      expect(new URL(LLM_PROVIDER_PRESETS.openai.defaultBaseUrl).hostname).toBe("api.openai.com");
      expect(new URL(LLM_PROVIDER_PRESETS.anthropic.defaultBaseUrl).hostname).toBe("api.anthropic.com");
      expect(new URL(LLM_PROVIDER_PRESETS.deepseek.defaultBaseUrl).hostname).toBe("api.deepseek.com");
      expect(new URL(LLM_PROVIDER_PRESETS.gemini.defaultBaseUrl).pathname).toBe("/v1beta/openai");
      expect(new URL(LLM_PROVIDER_PRESETS.openrouter.defaultBaseUrl).pathname).toBe("/api/v1");
      expect(LLM_PROVIDER_PRESETS.ollama.defaultBaseUrl).toBe(LOOPBACK_OLLAMA);
      expect(LLM_PROVIDER_PRESETS.ollama.requiresApiKey).toBe(false);
      expect(LLM_PROVIDER_PRESETS.cowork.defaultBaseUrl).toBe(LOOPBACK_COWORK);

      const utmPrefix = ["utm", ""].join("_");
      for (const preset of Object.values(LLM_PROVIDER_PRESETS)) {
        expect(preset.defaultBaseUrl.toLowerCase()).not.toContain(utmPrefix);
      }
    });

    it("supports multi-provider CRUD, default fallback, role routing, subscription unlock, and 0o600 persistence", () => {
      const registry = new ProviderRegistry(tmpDir);
      expect(registry.hasActiveConnection()).toBe(false);

      const openai = registry.upsertProvider({
        preset: "openai",
        apiKey: "tok-unit-alpha-9876",
        models: ["gpt-5", "gpt-4.1"],
        defaultModel: "gpt-5",
      });
      const queryParam = ["utm", "source=demo"].join("_");
      const anthropic = registry.upsertProvider({
        preset: "anthropic",
        baseUrl: `${LLM_PROVIDER_PRESETS.anthropic.defaultBaseUrl}/?${queryParam}`,
        apiKey: "tok-unit-beta-4321",
      });
      const ollama = registry.upsertProvider({
        preset: "ollama",
      });

      expect(registry.hasActiveConnection()).toBe(true);
      expect(openai.id).toBe("openai");
      expect(anthropic.baseUrl).toBe(LLM_PROVIDER_PRESETS.anthropic.defaultBaseUrl);
      expect(ollama.baseUrl).toBe(LOOPBACK_OLLAMA);
      expect(registry.listProviders()).toHaveLength(3);
      expect(registry.getDefaultProviderId()).toBe("openai");

      const updatedAnthropic = registry.upsertProvider({
        id: anthropic.id,
        name: "Claude Official",
      });
      expect(updatedAnthropic.name).toBe("Claude Official");
      expect(updatedAnthropic.apiKey).toBe("tok-unit-beta-4321");

      registry.setDefaultProvider(anthropic.id);
      expect(registry.getDefaultProviderId()).toBe(anthropic.id);

      registry.setUnlockSubscriptions(true);
      registry.setRoleRouting({
        assessor: "openai/gpt-4.1-mini",
        executor: "anthropic/claude-sonnet-4-20250514",
        computerUse: "claude-3-7-sonnet-20250219",
        steward: "ollama/qwen2.5:14b",
      });

      const filePath = path.join(tmpDir, "sugent-providers.json");
      expect(fs.existsSync(filePath)).toBe(true);
      if (process.platform !== "win32") {
        const mode = fs.statSync(filePath).mode & 0o777;
        expect(mode).toBe(0o600);
      }

      const reloaded = new ProviderRegistry(tmpDir);
      expect(reloaded.listProviders()).toHaveLength(3);
      expect(reloaded.getDefaultProviderId()).toBe("anthropic");
      expect(reloaded.unlockSubscriptions).toBe(true);
      expect(reloaded.routing).toEqual({
        assessor: "openai/gpt-4.1-mini",
        executor: "anthropic/claude-sonnet-4-20250514",
        computerUse: "claude-3-7-sonnet-20250219",
        steward: "ollama/qwen2.5:14b",
      });

      const resolvedAssessor = reloaded.resolveModelTarget(
        reloaded.routing.assessor,
      );
      expect(resolvedAssessor.provider?.id).toBe("openai");
      expect(resolvedAssessor.model).toBe("gpt-4.1-mini");

      const resolvedBare = reloaded.resolveModelTarget(
        reloaded.routing.computerUse,
      );
      expect(resolvedBare.provider?.id).toBe("anthropic");
      expect(resolvedBare.model).toBe("claude-3-7-sonnet-20250219");

      expect(reloaded.removeProvider("anthropic")).toBe(true);
      expect(reloaded.getProvider("anthropic")).toBeUndefined();
      expect(reloaded.getDefaultProviderId()).toBe("openai");
    });

    it("redacts apiKey in publicView() and exposes only hasKey and keyTail", () => {
      const registry = new ProviderRegistry(tmpDir);
      registry.upsertProvider({
        id: "p-long",
        preset: "openai",
        apiKey: "tok-unit-redacted-7788",
      });
      registry.upsertProvider({
        id: "p-short",
        preset: "deepseek",
        apiKey: "abcd",
      });
      registry.upsertProvider({
        id: "p-empty",
        preset: "ollama",
      });

      const view = registry.publicView();
      const serialized = JSON.stringify(view);

      expect(serialized).not.toContain("tok-unit-redacted-7788");
      expect(serialized).not.toContain("abcd");
      expect(serialized).not.toContain('"apiKey"');

      const longItem = view.providers.find((p) => p.id === "p-long");
      const shortItem = view.providers.find((p) => p.id === "p-short");
      const emptyItem = view.providers.find((p) => p.id === "p-empty");

      expect(longItem?.hasKey).toBe(true);
      expect(longItem?.keyTail).toBe("7788");
      expect(shortItem?.hasKey).toBe(true);
      expect(shortItem?.keyTail).toBe("");
      expect(emptyItem?.hasKey).toBe(false);
      expect(emptyItem?.keyTail).toBe("");
    });

    it("derives Magpie API bases properly for anthropic root URL and OpenAI-compatible presets", () => {
      const anthropicV1 = LLM_PROVIDER_PRESETS.anthropic.defaultBaseUrl;
      const anthropicRoot = anthropicV1.replace(/\/v1$/, "");
      expect(
        deriveMagpieApiBases({
          preset: "anthropic",
          baseUrl: anthropicV1,
        }),
      ).toEqual({
        chat: anthropicV1,
        responses: "",
        anthropic: anthropicRoot,
      });

      const openaiV1 = LLM_PROVIDER_PRESETS.openai.defaultBaseUrl;
      expect(
        deriveMagpieApiBases({
          preset: "openai",
          baseUrl: `${openaiV1}/`,
        }),
      ).toEqual({
        chat: openaiV1,
        responses: openaiV1,
        anthropic: "",
      });

      const geminiBase = LLM_PROVIDER_PRESETS.gemini.defaultBaseUrl;
      expect(
        deriveMagpieApiBases({
          preset: "gemini",
          baseUrl: geminiBase,
        }),
      ).toEqual({
        chat: geminiBase,
        responses: "",
        anthropic: "",
      });

      expect(
        deriveMagpieApiBases({
          preset: "cowork",
          baseUrl: LOOPBACK_COWORK,
        }),
      ).toEqual({
        chat: LOOPBACK_COWORK,
        responses: LOOPBACK_COWORK,
        anthropic: LOOPBACK_COWORK.replace(/\/v1$/, ""),
      });
    });

    it("losslessly migrates legacy connected config only when registry is empty", () => {
      const registry = new ProviderRegistry(tmpDir);

      expect(
        registry.adoptLegacyProviderIfEmpty({
          baseUrl: LOOPBACK_GW_A,
          apiKey: "",
        }),
      ).toBeNull();
      expect(registry.listProviders()).toHaveLength(0);

      const migrated = registry.adoptLegacyProviderIfEmpty({
        baseUrl: `${LOOPBACK_GW_A}/`,
        apiKey: "tok-legacy-9900",
      });
      expect(migrated).not.toBeNull();
      expect(migrated?.preset).toBe("modelflare-legacy");
      expect(migrated?.baseUrl).toBe(LOOPBACK_GW_A);
      expect(migrated?.apiKey).toBe("tok-legacy-9900");
      expect(registry.getDefaultProviderId()).toBe(migrated?.id);

      const secondAttempt = registry.adoptLegacyProviderIfEmpty({
        baseUrl: LOOPBACK_GW_B,
        apiKey: "tok-other-1122",
      });
      expect(secondAttempt).toBeNull();
      expect(registry.listProviders()).toHaveLength(1);
    });
  });

  describe("SugentModelCatalog", () => {
    it("resolves Claude native anthropic endpoint, OpenAI responses endpoint, DeepSeek, Gemini, Qwen, Llama, and zero-cost Ollama models", () => {
      const opus = resolveBuiltinModelInfo("claude-opus-4-20250514");
      expect(opus.endpoints).toEqual(["anthropic", "openai"]);
      expect(opus.vision).toBe(true);
      expect(opus.tools).toBe(true);
      expect(opus.rates?.input).toBeGreaterThan(0);

      const sonnet = resolveBuiltinModelInfo(
        "anthropic/claude-sonnet-4-20250514",
      );
      expect(sonnet.endpoints).toEqual(["anthropic", "openai"]);
      expect(sonnet.rates).toMatchObject({ input: 3, output: 15 });

      const claude35 = resolveBuiltinModelInfo("claude-3-5-sonnet-20241022");
      expect(claude35.endpoints).toEqual(["anthropic", "openai"]);

      const claude37 = resolveBuiltinModelInfo("claude-3-7-sonnet-20250219");
      expect(claude37.endpoints).toEqual(["anthropic", "openai"]);
      expect(claude37.reasoning).toBe(true);

      for (const model of [
        "gpt-5",
        "gpt-4.1-mini",
        "gpt-4o",
        "o3",
        "o4-mini",
      ]) {
        const info = resolveBuiltinModelInfo(model);
        expect(info.endpoints).toEqual(["openai-response", "openai"]);
        expect(info.rates?.input).toBeGreaterThan(0);
      }

      const dsReasoner = resolveBuiltinModelInfo("deepseek-reasoner");
      expect(dsReasoner.reasoning).toBe(true);
      expect(dsReasoner.endpoints).toEqual(["openai"]);

      const gemini = resolveBuiltinModelInfo("gemini-2.5-pro");
      expect(gemini.context).toBeGreaterThanOrEqual(1_000_000);
      expect(gemini.vision).toBe(true);

      const qwen = resolveBuiltinModelInfo("qwen2.5-coder-32b-instruct");
      expect(qwen.rates?.input).toBeGreaterThan(0);

      const llama = resolveBuiltinModelInfo("meta-llama/llama-3.3-70b-instruct");
      expect(llama.rates?.input).toBeGreaterThan(0);

      const ollamaQwen = resolveBuiltinModelInfo("ollama/qwen2.5:14b");
      expect(ollamaQwen.endpoints).toEqual(["openai"]);
      expect(ollamaQwen.rates).toEqual({ input: 0, output: 0 });
    });

    it("applies user context and rate overrides from sugent-model-overrides.json after stripping provider prefixes", () => {
      const overridesPath = path.join(tmpDir, "sugent-model-overrides.json");
      fs.writeFileSync(
        overridesPath,
        JSON.stringify({
          "claude-sonnet-4-20250514": {
            context: 1_000_000,
            rates: { input: 6, output: 22.5 },
          },
          "qwen2.5:14b": {
            context: 65_536,
            rates: { input: 0.1, output: 0.2 },
          },
        }),
        "utf8",
      );

      const catalog = new SugentModelCatalog(tmpDir);

      const sonnet = catalog.getModelInfo(
        "openrouter/anthropic/claude-sonnet-4-20250514",
      );
      expect(sonnet.context).toBe(1_000_000);
      expect(sonnet.endpoints).toEqual(["anthropic", "openai"]);
      expect(sonnet.rates).toMatchObject({
        input: 6,
        output: 22.5,
        cacheRead: 0.3,
        cacheWrite: 3.75,
      });

      const localQwen = catalog.getModelInfo("ollama/qwen2.5:14b");
      expect(localQwen.context).toBe(65_536);
      expect(localQwen.rates).toEqual({ input: 0.1, output: 0.2 });

      const cost = catalog.estimateCostUsd(
        "anthropic/claude-sonnet-4-20250514",
        {
          inputTokens: 500_000,
          outputTokens: 100_000,
        },
      );
      expect(cost).toBeCloseTo(3 + 2.25, 6);
    });
  });

  describe("LocalBudgetLedger", () => {
    it("tracks monthly bot spend, triggers 20% lowReserve protection, persists with 0o600, and resets across months", () => {
      const nov10 = Date.parse("2026-11-10T10:00:00.000Z");
      const nov20 = Date.parse("2026-11-20T12:00:00.000Z");
      const nov25 = Date.parse("2026-11-25T15:00:00.000Z");
      const dec01 = Date.parse("2026-12-01T00:05:00.000Z");

      const ledger = new LocalBudgetLedger(tmpDir);
      ledger.setBotBudget("bot-alpha", { enabled: true, limitUsd: 10 }, nov10);
      ledger.setBotBudget(
        "bot-disabled",
        { enabled: false, limitUsd: 5 },
        nov10,
      );

      const at80Pct = ledger.recordUsageCost("bot-alpha", 8.0, nov20);
      expect(at80Pct).toEqual({
        enabled: true,
        limitUsd: 10,
        usedUsd: 8,
        remainUsd: 2,
        exhausted: false,
        lowReserve: false,
      });

      const atLowReserve = ledger.recordUsageCost("bot-alpha", 0.05, nov20);
      expect(atLowReserve).toEqual({
        enabled: true,
        limitUsd: 10,
        usedUsd: 8.05,
        remainUsd: 1.95,
        exhausted: false,
        lowReserve: true,
      });

      const atExhausted = ledger.recordUsageCost("bot-alpha", 2.5, nov25);
      expect(atExhausted).toEqual({
        enabled: true,
        limitUsd: 10,
        usedUsd: 10.55,
        remainUsd: 0,
        exhausted: true,
        lowReserve: true,
      });

      const disabledStatus = ledger.recordUsageCost("bot-disabled", 9.9, nov25);
      expect(disabledStatus.enabled).toBe(false);
      expect(disabledStatus.exhausted).toBe(false);
      expect(disabledStatus.lowReserve).toBe(false);

      const budgetFilePath = path.join(tmpDir, "sugent-budgets.json");
      expect(fs.existsSync(budgetFilePath)).toBe(true);
      if (process.platform !== "win32") {
        const mode = fs.statSync(budgetFilePath).mode & 0o777;
        expect(mode).toBe(0o600);
      }

      const reloaded = new LocalBudgetLedger(tmpDir);
      const novActive = reloaded.allActiveBudgets(nov25);
      expect(novActive).toHaveLength(1);
      expect(novActive[0]?.botId).toBe("bot-alpha");
      expect(novActive[0]?.usedUsd).toBe(10.55);
      expect(novActive[0]?.exhausted).toBe(true);

      const decStatus = reloaded.getBotBudgetStatus("bot-alpha", dec01);
      expect(decStatus).toEqual({
        enabled: true,
        limitUsd: 10,
        usedUsd: 0,
        remainUsd: 10,
        exhausted: false,
        lowReserve: false,
      });

      const decAfterSpend = reloaded.recordUsageCost("bot-alpha", 1.25, dec01);
      expect(decAfterSpend.usedUsd).toBe(1.25);
      expect(decAfterSpend.remainUsd).toBe(8.75);
    });
  });
});
