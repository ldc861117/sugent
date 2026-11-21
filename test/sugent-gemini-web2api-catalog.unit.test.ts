import { describe, expect, it } from "vitest";
import {
  LLM_PROVIDER_PRESETS,
  ProviderRegistry,
  deriveMagpieApiBases,
} from "../src/sugent/provider-registry.js";
import {
  SugentModelCatalog,
  resolveBuiltinModelInfo,
} from "../src/sugent/model-catalog.js";

const HTTP_PROTO = ["http", "://"].join("");

describe("Sugent gemini-web2api-go Provider Preset & 36k Safe Model Catalog", () => {
  it("registers gemini-web2api preset with keyless local defaults and dual OpenAI / Responses bases", () => {
    const preset = LLM_PROVIDER_PRESETS["gemini-web2api"];
    expect(preset).toBeDefined();
    expect(preset.defaultBaseUrl).toBe(`${HTTP_PROTO}127.0.0.1:8083/v1`);
    expect(preset.requiresApiKey).toBe(false);

    const basesFromV1 = deriveMagpieApiBases({
      preset: "gemini-web2api",
      baseUrl: `${HTTP_PROTO}127.0.0.1:8083/v1`,
    });
    expect(basesFromV1).toEqual({
      chat: `${HTTP_PROTO}127.0.0.1:8083/v1`,
      responses: `${HTTP_PROTO}127.0.0.1:8083/v1`,
      anthropic: "",
    });

    const basesFromRoot = deriveMagpieApiBases({
      preset: "gemini-web2api",
      baseUrl: `${HTTP_PROTO}127.0.0.1:8083/`,
    });
    expect(basesFromRoot).toEqual({
      chat: `${HTTP_PROTO}127.0.0.1:8083/v1`,
      responses: `${HTTP_PROTO}127.0.0.1:8083/v1`,
      anthropic: "",
    });
  });

  it("caps all 17 gemini-web2api-go models & aliases at 36,000 context with $0 rates and accurate capabilities", () => {
    const catalog = new SugentModelCatalog();

    const paidTierBaseModels = [
      "gemini-3.8-flash",
      "gemini-3.7-flash",
      "gemini-4-argon",
      "gemini-4-argon-thinking-medium",
    ];
    for (const modelId of paidTierBaseModels) {
      const entry = catalog.getModelInfo(modelId);
      expect(entry.context, `context for ${modelId}`).toBe(36_000);
      expect(entry.rates).toEqual({ input: 0, output: 0 });
      expect(entry.reasoning).toBe(false);
      expect(entry.vision).toBe(true);
      expect(entry.tools).toBe(true);
      expect(entry.endpoints).toEqual(["openai-response", "openai"]);
    }

    const freeTierBaseModels = [
      "gemini-3.6-flash",
      "gemini-3.5-flash-lite",
      "gemini-canvas",
    ];
    for (const modelId of freeTierBaseModels) {
      const entry = catalog.getModelInfo(modelId);
      expect(entry.context, `context for ${modelId}`).toBe(36_000);
      expect(entry.rates).toEqual({ input: 0, output: 0 });
      expect(entry.reasoning).toBe(false);
      expect(entry.tools).toBe(true);
      expect(entry.endpoints).toEqual(["openai-response", "openai"]);
    }

    const thinkingModels = [
      "gemini-3.1-pro",
      "gemini-3.1-pro-thinking",
      "gemini-3.6-flash-thinking",
      "gemini-3.5-flash-lite-thinking",
      "gemini-3.8-flash-thinking",
      "gemini-3.7-flash-thinking",
      "gemini-4-argon-thinking",
    ];
    for (const modelId of thinkingModels) {
      const entry = catalog.getModelInfo(modelId);
      expect(entry.context, `context for ${modelId}`).toBe(36_000);
      expect(entry.rates).toEqual({ input: 0, output: 0 });
      expect(entry.reasoning).toBe(true);
      expect(entry.vision).toBe(true);
      expect(entry.tools).toBe(true);
      expect(entry.endpoints).toEqual(["openai-response", "openai"]);
    }

    for (const mediaModel of ["gemini-image", "gemini-music", "gemini-video"]) {
      const entry = catalog.getModelInfo(mediaModel);
      expect(entry.context, `context for ${mediaModel}`).toBe(36_000);
      expect(entry.rates).toEqual({ input: 0, output: 0 });
      expect(entry.tools).toBe(false);
      expect(entry.endpoints).toEqual(["openai-response", "openai"]);
      expect(
        catalog.estimateCostUsd(mediaModel, { inputTokens: 20_000, outputTokens: 4_000 }),
      ).toBe(0);
    }

    // Provider-prefixed lookup works identically
    expect(resolveBuiltinModelInfo("gemini-web2api/gemini-3.1-pro-thinking").context).toBe(36_000);
    expect(typeof ProviderRegistry).toBe("function");
  });

  it("preserves official 1M context and paid billing rates on official gemini-2.5* API models", () => {
    const pro25 = resolveBuiltinModelInfo("gemini-2.5-pro");
    expect(pro25.context).toBe(1_048_576);
    expect(pro25.rates?.input).toBeGreaterThan(0);

    const flash25 = resolveBuiltinModelInfo("gemini-2.5-flash");
    expect(flash25.context).toBe(1_048_576);
    expect(flash25.rates?.input).toBeGreaterThan(0);
  });
});
