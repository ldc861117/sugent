import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "../src/sugent/provider-registry.js";
import { ModelPoolSyncer } from "../src/sugent/model-pool-sync.js";
import {
  SugentModelCatalog,
  classifyModelProfile,
  hasBuiltinModelRule,
  parseModelSpecMetadata,
  resolveBuiltinModelInfo,
} from "../src/sugent/model-catalog.js";

describe("Sugent Model Capability Profiler & Non-Chat Filter", () => {
  it("classifies CLIProxyAPI prefixed/suffixed chat models and excludes non-chat media/embedding models", () => {
    const catalog = new SugentModelCatalog();

    const g4Hydrogen = classifyModelProfile("custom-gateway/gemini-4-hydrogen-xhigh", catalog);
    expect(g4Hydrogen.isChatModel).toBe(true);
    expect(g4Hydrogen.family).toBe("gemini");
    expect(g4Hydrogen.tier).toBe("reasoning");
    expect(g4Hydrogen.context).toBe(1_048_576);
    expect(g4Hydrogen.vision).toBe(true);
    expect(g4Hydrogen.tools).toBe(true);
    expect(g4Hydrogen.thoughtSignatureRequired).toBe(true);
    expect(g4Hydrogen.inferredFromFallback).toBe(false);

    const g4Neon = classifyModelProfile("custom-gateway/gemini-4-neon-xhigh", catalog);
    expect(g4Neon.isChatModel).toBe(true);
    expect(g4Neon.family).toBe("gemini");
    expect(g4Neon.tier).toBe("reasoning");
    expect(g4Neon.context).toBe(1_048_576);
    expect(g4Neon.thoughtSignatureRequired).toBe(true);

    const g4Flash = classifyModelProfile("gemini-4-flash", catalog);
    expect(g4Flash.context).toBe(1_048_576);
    expect(g4Flash.tier).toBe("balanced");
    expect(g4Flash.rates?.input).toBe(0.3);

    const claudeSonnet = classifyModelProfile("anthropic/claude-sonnet-4-6", catalog);
    expect(claudeSonnet.family).toBe("claude");
    expect(claudeSonnet.tier).toBe("frontier");
    expect(claudeSonnet.thoughtSignatureRequired).toBe(false);

    const mini = classifyModelProfile("openai/gpt-4.1-mini", catalog);
    expect(mini.family).toBe("openai");
    expect(mini.tier).toBe("balanced");

    const nano = classifyModelProfile("gpt-5-nano", catalog);
    expect(nano.tier).toBe("fast");

    const nonChatModels = [
      "text-embedding-3-large",
      "bge-embed-v1",
      "tts-1-hd",
      "whisper-1",
      "dall-e-3",
      "imagen-3.0",
      "veo-2",
      "lyria-2",
      "sora-2",
      "omni-moderation-latest",
      "bge-rerank-v2",
      "gemini-image",
      "gemini-music",
      "gemini-video",
    ];
    for (const nonChat of nonChatModels) {
      const p = classifyModelProfile(nonChat, catalog);
      expect(p.isChatModel, nonChat).toBe(false);
    }

    const meta = parseModelSpecMetadata("custom-gateway/gemini-4-hydrogen-xhigh");
    expect(meta).toMatchObject({
      bareModelId: "gemini-4-hydrogen-xhigh",
      hasXHighTag: true,
      hasThinkingTag: false,
      family: "gemini",
    });
    expect(hasBuiltinModelRule("custom-gateway/gemini-4-hydrogen-xhigh")).toBe(true);
    expect(hasBuiltinModelRule("custom-gateway/my-custom-alias-v1")).toBe(false);
    expect(classifyModelProfile("my-custom-alias-v1", catalog).inferredFromFallback).toBe(true);

    // Preserve existing gemini-web2api 36k wall invariant
    expect(resolveBuiltinModelInfo("gemini-web2api/gemini-3.1-pro-thinking").context).toBe(36_000);
    expect(resolveBuiltinModelInfo("gemini-4-argon").context).toBe(36_000);
    expect(resolveBuiltinModelInfo("gemini-4-argon").rates).toEqual({ input: 0, output: 0 });
    expect(resolveBuiltinModelInfo("gemini-image").context).toBe(36_000);
  });
});

describe("ModelPoolSyncer & Circuit Breaker", () => {
  it("syncs all CLIProxyAPI /v1/models, keeps offline cache on failure, probes unknown aliases, and runs exponential circuit breaker", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-pool-"));
    try {
      const reg = new ProviderRegistry(tmp);
      reg.upsertProvider({
        id: "cliproxy",
        name: "CLIProxyAPI",
        preset: "custom-openai",
        baseUrl: "http://127.0.0.1:8317/v1",
        apiKey: "sk-cliproxy-test",
        enabled: true,
        setDefault: true,
      });
      const catalog = new SugentModelCatalog(tmp);
      let failModelsEndpoint = false;
      let nowMs = 1_700_000_000_000;
      const mockFetch: typeof fetch = async (url, init) => {
        const u = String(url);
        if (u.endsWith("/models")) {
          if (failModelsEndpoint) throw new Error("network down");
          return new Response(
            JSON.stringify({
              data: [
                { id: "gemini-4-hydrogen-xhigh" },
                { id: "claude-sonnet-4-6" },
                { id: "gpt-4.1-mini" },
                { id: "my-custom-alias-v1" },
                { id: "text-embedding-3-small" },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
        return new Response(
          JSON.stringify({
            model: body.model,
            choices: [{ message: { role: "assistant", content: "ok", tool_calls: [{ id: "t1", type: "function", function: { name: "ping", arguments: "{}" } }] } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };
      const syncer = new ModelPoolSyncer({ dataDir: tmp, providers: reg, catalog, fetchImpl: mockFetch, nowMs: () => nowMs });
      const res = await syncer.syncProvider("cliproxy", { force: true });
      expect(res.ok).toBe(true);
      expect(res.discoveredCount).toBe(5);
      expect(res.chatModelCount).toBe(4);
      expect(reg.getProvider("cliproxy")?.models).toHaveLength(5);

      const probed = await syncer.probeUnknownModels({ maxProbes: 2 });
      expect(probed).toBe(1);
      expect(syncer.getEntry("cliproxy/my-custom-alias-v1")?.probe?.ok).toBe(true);
      expect(syncer.getEntry("cliproxy/my-custom-alias-v1")?.probe?.toolCallingSupported).toBe(true);

      failModelsEndpoint = true;
      const offline = await syncer.syncProvider("cliproxy", { force: true });
      expect(offline.ok).toBe(false);
      expect(syncer.listChatCandidates()).toHaveLength(4);
      syncer.recordInfraFailure("cliproxy/claude-sonnet-4-6", 429, nowMs);
      expect(syncer.isModelAvailable("cliproxy/claude-sonnet-4-6", nowMs + 10_000)).toBe(false);
      expect(syncer.getPoolSnapshot(nowMs + 10_000).coolingChatModels).toBe(1);
      expect(syncer.isModelAvailable("cliproxy/claude-sonnet-4-6", nowMs + 61_000)).toBe(true);
      expect(syncer.getEntry("cliproxy/claude-sonnet-4-6")?.circuit.state).toBe("half_open");
      syncer.recordInfraSuccess("cliproxy/claude-sonnet-4-6", nowMs + 62_000);
      expect(syncer.getEntry("cliproxy/claude-sonnet-4-6")?.circuit.state).toBe("closed");

      // Reload from atomic 0o600 pool cache without touching KnowledgeGraph
      const poolFile = path.join(tmp, "sugent-routing", "model-pool.json");
      expect(fs.existsSync(poolFile)).toBe(true);
      if (process.platform !== "win32") {
        expect(fs.statSync(poolFile).mode & 0o777).toBe(0o600);
      }
      expect(fs.existsSync(path.join(tmp, "sugent-kg.json"))).toBe(false);
      const reloaded = new ModelPoolSyncer({ dataDir: tmp, providers: reg, catalog, fetchImpl: mockFetch, nowMs: () => nowMs });
      expect(reloaded.listChatCandidates()).toHaveLength(4);
      expect(reloaded.getEntry("cliproxy/my-custom-alias-v1")?.probe?.ok).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("handles exponential 429 backoff, 404 needsResync clearing, 5xx failure threshold, and syncAllEnabled throttling", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-pool-edge-"));
    try {
      const reg = new ProviderRegistry(tmp);
      reg.upsertProvider({ id: "cp", preset: "custom-openai", baseUrl: "http://127.0.0.1:8317/v1", apiKey: "k", models: ["gpt-5-nano", "claude-sonnet-4-6"], enabled: true });
      const catalog = new SugentModelCatalog(tmp);
      let nowMs = 1_700_000_000_000;
      let fetchCalls = 0;
      const syncer = new ModelPoolSyncer({
        dataDir: tmp, providers: reg, catalog, nowMs: () => nowMs,
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response(JSON.stringify({ data: [{ id: "gpt-5-nano" }, { id: "claude-sonnet-4-6" }] }), { status: 200 });
        },
      });
      await syncer.syncAllEnabled({ force: true });
      expect(fetchCalls).toBe(1);
      await syncer.syncAllEnabled({ minIntervalMs: 60_000 });
      expect(fetchCalls).toBe(1);
      nowMs += 65_000;
      await syncer.syncAllEnabled({ minIntervalMs: 60_000 });
      expect(fetchCalls).toBe(2);

      // Single 500 stays closed; 2nd consecutive opens circuit
      expect(syncer.recordInfraFailure("cp/gpt-5-nano", 500, nowMs).state).toBe("closed");
      expect(syncer.recordInfraFailure("cp/gpt-5-nano", 500, nowMs + 1000).state).toBe("open");
      expect(syncer.isModelAvailable("cp/gpt-5-nano", nowMs + 60_000)).toBe(false);

      // 404 marks needsResync; next sync clears circuit
      const s404 = syncer.recordInfraFailure("cp/claude-sonnet-4-6", 404, nowMs);
      expect(s404.needsResync).toBe(true);
      await syncer.syncProvider("cp", { force: true });
      expect(syncer.getEntry("cp/claude-sonnet-4-6")?.circuit.state).toBe("closed");
      expect(syncer.getEntry("cp/claude-sonnet-4-6")?.circuit.needsResync).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
