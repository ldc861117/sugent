# CLIProxyAPI 全量模型对齐与经验驱动自适应路由（M1–M3 完整落地）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Sugent 动态全量同步 CLIProxyAPI（及任意 BYOK 兼容端点）暴露的所有可用对话模型，并通过零额外 LLM 延迟（`<5ms`）的经验驱动自适应路由器，实现“用户零心智选模 + 平衡策略自动择优 + 双层韧性回退与质量升档 + 越用越准”。

**Architecture:** 将架构解耦为三层：**供给面**（`ModelPoolSyncer` 定时/按需拉取 `/v1/models`、过滤非对话模型、用增强后的 `SugentModelCatalog` 推断能力与档位，并维护单模型指数熔断器）、**决策面**（`AdaptiveModelRouter` + `RoutingExperienceStore` 通过 6 类任务原型与前置硬约束剪枝，结合贝叶斯平滑时间衰减后验分、受控 UCB 探索、平衡档成本/配额稀缺权重选出主备候选链）、**执行与反馈面**（`StewardLlmAgent` 支持首轮平级秒切与质量升档、Tool Loop 回合内锁定以保护 Gemini 4 `thought_signature`、90s 隐式用户纠偏惩罚、UI“换更强模型重试”强反馈及 Vibe Coding 门禁结果回流）。

**Tech Stack:** TypeScript 7 (ESM `NodeNext`, Node `>=22.13`), Preact 11 + `htm` (`ui/`), Vitest (`npm run test:sugent`), 本地 `0o600` 原子 JSON 持久化，零新增第三方运行时依赖。

---

## Pre-Plan Commercial Reflection Gate（商业策略自省四问）

1. **付费锚点（Why Pay & Moat）**：属于“开源引流基座 + 商业确定性护城河放大器”。相比单一厂商模型全家桶（WorkBuddy、千问办公等），本能力放大了 Sugent 的**跨模型生态中立性**、**防 429 业务连续性**以及**本地私有历史经验驱动的任务路由精度**——系统越用越懂主人每类任务该派哪个模型，同时确保高风险工具调度与防社死拟稿默认分配给已验证的高可靠模型。
2. **合规与分发（Distribution & ToS Risk）**：全链路基于标准 HTTP OpenAI `/v1/models` 与 `/v1/chat/completions`（及 Anthropic 原生协议），零硬编码客户端密钥、零新增原生二进制依赖，不影响 macOS 公证 / Windows 签名 / 企业审计；CLIProxyAPI 仅作为用户自配的标准兼容网关（BYOK First），不构成绑定依赖。
3. **离线退路（Sovereignty Fallback）**：完全兼容 `mode: "none"` 免登录离线主权模式；模型池缓存、熔断状态、历史经验账本与策略规则 100% 落盘于本地 `<dataDir>/sugent-routing/`，无云端路由器、不上传对话正文；断网或 `/v1/models` 不可达时自动复用本地缓存池、本机 Ollama 与现有规则兜底。
4. **一人公司运维杠杆（OPC Ops Leverage）**：纯端侧本地状态机 + 无后台运维成本；CLIProxyAPI 上游新增/下线模型由客户端自动发现、推断画像并以小流量低风险试跑接管，单人架构师无需手动维护路由规则表。

---

## Global Constraints

- **零侵入边界**：自研核心逻辑一律放在 `src/sugent/`、测试放在 `test/sugent*.unit.test.ts`、计划文档放在 `docs/plans/`；仅在 `src/app.ts`、`src/web/server.ts`、`scripts/` 与 `ui/` 做薄适配接线，不修改上游 `src/tasks/service.ts`、`src/channels/` 或 `packages/dsh-superagent/`。
- **既有契约向后兼容**：必须 100% 保留现有 `SugentModelCatalog` 规则（特别是 `gemini-web2api` 的 `36_000` 上下文安全墙与 `rates: { input: 0, output: 0 }`）、`ProviderRegistry` 接口、以及 `StewardLlmAgent` 仅传入 `getEndpoint()` 时的兼容行为。
- **知识图谱测试契约**：禁止在 `App` 启动或周期同步时自动向 `SugentKnowledgeGraph` 写入模型节点（避免破坏 `test/sugent-p2-web-api.unit.test.ts` 的 `nodeCount` 断言）；所有路由与经验状态持久化至 `<dataDir>/sugent-routing/`，全部采用临时文件 + `0o600` 原子重命名。
- **回合内粘性不变量（Intra-Turn Stickiness）**：`StewardLlmAgent.runTurn` 一旦在 Round 0 拿到合法 `tool_calls` 进入多轮 Tool Loop（Round 1–4），**严禁中途更换模型**，以保护 Gemini 4 的 `extra_content.google.thought_signature` 校验不中断；基础设施切备与质量升档仅作用于 Round 0（或下一次全新轮次）。
- **平衡策略为默认**：默认战略档位为 `"balanced"`（质量 `0.48` / 健康 `0.20` / 速度 `0.14` / 成本与配额稀缺度 `0.18`），将美元按量计费与 CLIProxyAPI 订阅池配额稀缺度、429 频率及 `LocalBudgetLedger` 预算压力统一量化。
- **双语 UI 同步**：`ui/locales/zh-CN/` 与 `ui/locales/en/` 必须同步新增键名一致的国际化文案；零新增 npm 依赖。
- **强制验证门禁**：全部实现完成后，必须顺序通过 `npm run typecheck`、`npm run test:sugent` 与 `npm run verify:sugent`（含 `docs:check`）。

---

## File Structure & Module Map

- **Create**:
  - `src/sugent/model-pool-sync.ts` — 多服务商 `/v1/models` 动态发现（CLIProxyAPI + BYOK）、非对话模型过滤、未知模型懒探针、单模型指数熔断器与快照管理。
  - `src/sugent/routing-experience-store.ts` — 按 `(archetype, targetId)` 持久化时间衰减 EWMA 经验账本、贝叶斯后验计算、90s 隐式纠偏检测、最近决策环形缓冲区，以及自然语言软策略规则管理。
  - `src/sugent/adaptive-router.ts` — 6 类任务原型 `<5ms` 零延迟分类器、前置硬约束剪枝器、Contextual Bandit 评分器、跨家族备选与升档链规划器、因果账本记录器与看板聚合器。
  - `test/sugent-model-pool-sync.unit.test.ts` — 模型画像推断、`/v1/models` 同步、离线缓存回退、非对话模型剔除、懒探针及熔断状态机单测。
  - `test/sugent-adaptive-router.unit.test.ts` — 任务分类、硬门禁剪枝、贝叶斯冷启动收敛、时间衰减、预算压力降档、受控探索、Shadow 模式及自然语言指令单测。
  - `test/sugent-steward-adaptive-routing.e2e.unit.test.ts` — `StewardLlmAgent` + `SugentStewardHostService` + Web API 端到端集成测试（429 无感秒切、Gemini `thought_signature` 回合粘性、Round 0 质量升档、隐式纠偏、一键更强模型重试、真实计费、`verify-now` 门禁反馈）。
- **Modify**:
  - `src/sugent/model-catalog.ts` — 新增 `ModelTier` / `ModelFamily` / `ModelModality` / `ModelCapabilityProfile`、`parseModelSpecMetadata`、`classifyModelProfile` 及 Gemini 3/4 与非对话模型规则（完整保留既有 `gemini-web2api` 36k 规则）。
  - `src/sugent/steward-llm-agent.ts` — 支持 `resolveRoutePlan`、`estimateCostUsd`、`onRouteAttemptOutcome`、双层策略级联（平级秒切 + Round 0 质量升档）、回合内粘性锁定、`retryStronger` 与 `manage_model_routing` 工具。
  - `src/sugent/steward-host-service.ts` — 集成 `ModelPoolSyncer`、`RoutingExperienceStore`、`AdaptiveModelRouter`，新增同步/看板/策略/重试方法、隐式纠偏捕捉、Vibe Coding 门禁回报及 workbench `routing` 字段。
  - `src/sugent/index.ts` — 导出新增 3 个路由与同步模块。
  - `src/app.ts` — 向 `SugentStewardHostService` 注入 `modelCatalog` 与 `llmFetch`，新增 `syncProviderModels()` 并在启动和配置服务商时触发非阻塞全量同步。
  - `src/web/server.ts` — 暴露 `POST /providers/sync-models`、`GET /steward/routing`、`PUT /steward/routing/policy`、`POST /steward/routing/sync`、`POST /steward/routing/retry-stronger`。
  - `scripts/start-jarvis-workbench.mjs` — 移除 CLIProxyAPI 硬编码 2 模型限制，启动后调用 `syncProviderModels("custom-gateway", true)` 对齐全量模型并供 UI 下拉/自动路由消费。
  - `scripts/write-build-manifest.mjs` — 在构筑自感知能力清单中补充动态对齐与经验路由亮点。
  - `scripts/verify-sugent.mjs` — 新增第 21 节契约校验。
  - `package.json` — 将 3 个新测试文件加入 `test:sugent`。
  - `ui/components/jarvis-workbench.js` — 在管家总览页新增精简的“智能路由与模型池”卡片（策略三档、Auto/Shadow 开关、同步模型池、最近路由决策+一键换更强模型重试、各原型经验榜）。
  - `ui/components/provider-settings.js` — 为每个服务商行增加“同步模型”按钮与已同步模型计数徽章。
  - `ui/locales/zh-CN/steward.js`, `ui/locales/en/steward.js`, `ui/locales/zh-CN/onboarding.js`, `ui/locales/en/onboarding.js` — 补全双语文案。

---

### Task 1: 增强模型能力、家族、档位与非对话模态画像（`src/sugent/model-catalog.ts`）

**Files:**
- Modify: `src/sugent/model-catalog.ts:250-445,705-716`
- Test: `test/sugent-model-pool-sync.unit.test.ts`

**Interfaces:**
- Consumes: `CatalogModelInfo`, `CatalogModelRates`, `SugentModelCatalog`, `stripProviderPrefix`, `resolveBuiltinModelInfo`（`src/sugent/model-catalog.ts`）
- Produces:
  - `export type ModelTier = "fast" | "balanced" | "frontier" | "reasoning";`
  - `export type ModelFamily = "claude" | "openai" | "gemini" | "deepseek" | "qwen" | "llama" | "other";`
  - `export type ModelModality = "chat" | "image_gen" | "audio" | "video" | "embedding";`
  - `export interface ModelCapabilityProfile { rawModelId: string; bareModelId: string; family: ModelFamily; tier: ModelTier; modalities: ModelModality[]; isChatModel: boolean; context: number; vision: boolean; tools: boolean; reasoning: boolean; thoughtSignatureRequired: boolean; priorQuality: number; quotaScarcity: number; rates?: CatalogModelRates; inferredFromFallback: boolean; }`
  - `export function hasBuiltinModelRule(modelId: string): boolean`
  - `export function parseModelSpecMetadata(rawModelId: string): { bareModelId: string; normalized: string; hasThinkingTag: boolean; hasXHighTag: boolean; family: ModelFamily }`
  - `export function classifyModelProfile(modelId: string, catalog?: SugentModelCatalog): ModelCapabilityProfile`

- [ ] **Step 1: 编写失败单测 `test/sugent-model-pool-sync.unit.test.ts`（模型画像部分）**

```ts
import { describe, expect, it } from "vitest";
import {
  SugentModelCatalog,
  classifyModelProfile,
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

    const claudeSonnet = classifyModelProfile("anthropic/claude-sonnet-4-6", catalog);
    expect(claudeSonnet.family).toBe("claude");
    expect(claudeSonnet.tier).toBe("frontier");
    expect(claudeSonnet.thoughtSignatureRequired).toBe(false);

    const mini = classifyModelProfile("openai/gpt-4.1-mini", catalog);
    expect(mini.family).toBe("openai");
    expect(mini.tier).toBe("balanced");

    const nano = classifyModelProfile("gpt-5-nano", catalog);
    expect(nano.tier).toBe("fast");

    for (const nonChat of ["text-embedding-3-large", "tts-1-hd", "whisper-1", "gemini-image", "veo-2"]) {
      const p = classifyModelProfile(nonChat, catalog);
      expect(p.isChatModel, nonChat).toBe(false);
    }

    // Preserve existing gemini-web2api 36k wall invariant
    expect(resolveBuiltinModelInfo("gemini-web2api/gemini-3.1-pro-thinking").context).toBe(36_000);
    expect(resolveBuiltinModelInfo("gemini-4-argon").context).toBe(36_000);
  });
});
```

- [ ] **Step 2: 运行单测确认按预期失败**

Run: `npx vitest run test/sugent-model-pool-sync.unit.test.ts < /dev/null`
Expected: FAIL，提示 `classifyModelProfile is not a function` 或找不到符号。
- [ ] **Step 3: 在 `src/sugent/model-catalog.ts` 实现规则扩展与画像分类函数**

在 `BUILTIN_MODEL_RULES`（保留第 275–348 行既有 `gemini-web2api` 36k 规则不动）的 `// Google Gemini 2.5` 之前新增 Gemini 3/4 与非对话规则，并在文件末尾导出画像类型与分类函数：

```ts
  // 非对话模态排除规则（避免被 Steward 对话池选中）
  {
    match: (m) => /(^|[-_/])(embedding|embed|tts|whisper|dall-e|imagen|veo|lyria|sora|moderation|rerank)/.test(m),
    info: { context: 8_192, vision: false, tools: false, reasoning: false, endpoints: ["openai"] },
  },
  // Google Gemini 4 / 3 Official & CLIProxyAPI Chat Models（不匹配 gemini-4-argon* / gemini-3.1-pro*）
  {
    match: (m) => m.startsWith("gemini-4-flash") || m.startsWith("gemini-3-flash"),
    info: { context: 1_048_576, vision: true, tools: true, reasoning: true, endpoints: ["openai"], rates: { input: 0.3, output: 2.5, cacheRead: 0.075 } },
  },
  {
    match: (m) =>
      m.startsWith("gemini-4-hydrogen") || m.startsWith("gemini-4-neon") || m.startsWith("gemini-4-pro") || m.startsWith("gemini-3-pro"),
    info: { context: 1_048_576, vision: true, tools: true, reasoning: true, endpoints: ["openai"], rates: { input: 1.25, output: 10, cacheRead: 0.31 } },
  },
```

```ts
export type ModelTier = "fast" | "balanced" | "frontier" | "reasoning";
export type ModelFamily = "claude" | "openai" | "gemini" | "deepseek" | "qwen" | "llama" | "other";
export type ModelModality = "chat" | "image_gen" | "audio" | "video" | "embedding";

export interface ModelCapabilityProfile {
  rawModelId: string; bareModelId: string; family: ModelFamily; tier: ModelTier;
  modalities: ModelModality[]; isChatModel: boolean; context: number; vision: boolean;
  tools: boolean; reasoning: boolean; thoughtSignatureRequired: boolean;
  priorQuality: number; quotaScarcity: number; rates?: CatalogModelRates; inferredFromFallback: boolean;
}

export function hasBuiltinModelRule(modelId: string): boolean {
  const bareLower = stripProviderPrefix(modelId).toLowerCase();
  return BUILTIN_MODEL_RULES.some((rule) => rule.match(bareLower));
}

export function parseModelSpecMetadata(rawModelId: string) {
  const bareModelId = stripProviderPrefix(rawModelId);
  const normalized = bareModelId.toLowerCase();
  const family: ModelFamily = normalized.includes("claude") ? "claude"
    : (normalized.startsWith("gpt-") || /^o[134](-|$)/.test(normalized) || normalized.includes("codex")) ? "openai"
    : normalized.includes("gemini") ? "gemini"
    : normalized.includes("deepseek") ? "deepseek"
    : (normalized.startsWith("qwen") || normalized.startsWith("qwq")) ? "qwen"
    : normalized.includes("llama") ? "llama" : "other";
  return { bareModelId, normalized, hasThinkingTag: normalized.includes("thinking"), hasXHighTag: normalized.includes("xhigh"), family };
}

export function classifyModelProfile(modelId: string, catalog?: SugentModelCatalog): ModelCapabilityProfile {
  const meta = parseModelSpecMetadata(modelId);
  const info = catalog ? catalog.getModelInfo(modelId) : resolveBuiltinModelInfo(modelId);
  const m = meta.normalized;
  const modalities: ModelModality[] = [];
  if (/(embedding|embed|rerank)/.test(m)) modalities.push("embedding");
  else if (/(dall-e|imagen|gemini-image|image-gen)/.test(m)) modalities.push("image_gen");
  else if (/(tts|whisper|gemini-music|audio)/.test(m)) modalities.push("audio");
  else if (/(veo|sora|gemini-video)/.test(m)) modalities.push("video");
  else modalities.push("chat");
  const isChatModel = modalities.includes("chat");
  const isSmall = /(nano|lite|8b|7b|mini|flash|haiku|3\.5-turbo)/.test(m);
  const tier: ModelTier = !isChatModel ? "fast"
    : (meta.hasXHighTag || meta.hasThinkingTag || /^(o[134]|deepseek-r1|deepseek-reasoner|qwq)/.test(m) || m.includes("hydrogen") || m.includes("neon")) ? "reasoning"
    : (/(opus|sonnet-4|gpt-5|gpt-4\.1|gpt-4o|gemini-4-pro|gemini-3-pro|gemini-2\.5-pro|codex)/.test(m) && !isSmall) ? "frontier"
    : (/(nano|lite|8b|7b)/.test(m)) ? "fast"
    : (/(mini|flash|haiku|deepseek-chat|deepseek-v3|gpt-4o-mini|gpt-4\.1-mini|gpt-5-mini)/.test(m)) ? "balanced" : "balanced";
  const [priorQuality, quotaScarcity] = !isChatModel ? [0, 0]
    : tier === "reasoning" ? [0.92, 0.95] : tier === "frontier" ? [0.88, 0.80]
    : tier === "balanced" ? [0.78, 0.42] : [0.65, 0.15];
  return {
    rawModelId: modelId.trim(), bareModelId: meta.bareModelId, family: meta.family, tier, modalities, isChatModel,
    context: info.context ?? 128_000, vision: Boolean(info.vision), tools: Boolean(info.tools), reasoning: Boolean(info.reasoning),
    thoughtSignatureRequired: meta.family === "gemini" && (m.includes("gemini-3") || m.includes("gemini-4")) && isChatModel,
    priorQuality: hasBuiltinModelRule(modelId) ? priorQuality : Math.min(priorQuality, 0.72),
    quotaScarcity, ...(info.rates ? { rates: info.rates } : {}), inferredFromFallback: !hasBuiltinModelRule(modelId),
  };
}
```

- [ ] **Step 4: 运行单测并确保既有用例全绿**

Run: `npx vitest run test/sugent-model-pool-sync.unit.test.ts test/sugent-gemini-web2api-catalog.unit.test.ts < /dev/null`
Expected: PASS（两个测试文件全部通过）。

- [ ] **Step 5: 提交 Task 1**

```bash
git add src/sugent/model-catalog.ts test/sugent-model-pool-sync.unit.test.ts
git commit -m "feat(routing): extend model catalog capability and tier profiler"
```

---

### Task 2: CLIProxyAPI 动态模型池同步器与指数熔断器（`src/sugent/model-pool-sync.ts`）

**Files:**
- Create: `src/sugent/model-pool-sync.ts`
- Test: `test/sugent-model-pool-sync.unit.test.ts`（追加测试块）

**Interfaces:**
- Consumes: `ProviderRegistry`, `ProviderRecord`, `deriveMagpieApiBases`（`src/sugent/provider-registry.ts`），`SugentModelCatalog`, `ModelCapabilityProfile`, `classifyModelProfile`（`src/sugent/model-catalog.ts`）
- Produces:
  - `export interface ModelCircuitState { state: "closed" | "open" | "half_open"; consecutiveFailures: number; cooldownUntilMs: number; lastErrorCode?: string; lastFailureAtIso?: string; needsResync?: boolean; }`
  - `export interface SyncedModelEntry { targetId: string; providerId: string; rawModelId: string; bareModelId: string; baseUrl: string; profile: ModelCapabilityProfile; discoveredAtIso: string; lastSeenAtIso: string; source: "remote_sync" | "configured"; probe?: { probedAtIso: string; ok: boolean; ttftMs: number | null; toolCallingSupported: boolean | null }; circuit: ModelCircuitState; }`
  - `export interface ProviderSyncResult { providerId: string; ok: boolean; discoveredCount: number; chatModelCount: number; addedModels: string[]; removedModels: string[]; skippedReason?: string; error?: string; syncedAtIso: string; }`
  - `export interface ModelPoolSnapshot { lastSyncedAtIso: string | null; totalModels: number; chatModels: number; healthyChatModels: number; coolingChatModels: number; providersSynced: number; entries: SyncedModelEntry[]; }`
  - `export class ModelPoolSyncer`（方法：`syncProvider`, `syncAllEnabled`, `probeUnknownModels`, `recordInfraFailure`, `recordInfraSuccess`, `isModelAvailable`, `listChatCandidates`, `getEntry`, `getPoolSnapshot`）

- [ ] **Step 1: 在 `test/sugent-model-pool-sync.unit.test.ts` 追加同步、离线缓存回退、懒探针与熔断状态机失败测试**

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProviderRegistry } from "../src/sugent/provider-registry.js";
import { ModelPoolSyncer } from "../src/sugent/model-pool-sync.js";

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
          JSON.stringify({ model: body.model, choices: [{ message: { role: "assistant", content: "ok", tool_calls: [{ id: "t1", type: "function", function: { name: "ping", arguments: "{}" } }] } }] }),
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
      expect(syncer.isModelAvailable("cliproxy/claude-sonnet-4-6", nowMs + 61_000)).toBe(true);
      expect(syncer.getEntry("cliproxy/claude-sonnet-4-6")?.circuit.state).toBe("half_open");
      syncer.recordInfraSuccess("cliproxy/claude-sonnet-4-6", nowMs + 62_000);
      expect(syncer.getEntry("cliproxy/claude-sonnet-4-6")?.circuit.state).toBe("closed");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: 运行单测确认按预期失败**

Run: `npx vitest run test/sugent-model-pool-sync.unit.test.ts < /dev/null`
Expected: FAIL，找不到 `../src/sugent/model-pool-sync.js`。
- [ ] **Step 3: 创建 `src/sugent/model-pool-sync.ts`**

```ts
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { classifyModelProfile, type ModelCapabilityProfile, type SugentModelCatalog } from "./model-catalog.js";
import type { ProviderRecord, ProviderRegistry } from "./provider-registry.js";

export interface ModelCircuitState {
  state: "closed" | "open" | "half_open";
  consecutiveFailures: number;
  cooldownUntilMs: number;
  lastErrorCode?: string;
  lastFailureAtIso?: string;
  needsResync?: boolean;
}

export interface SyncedModelEntry {
  targetId: string;
  providerId: string;
  rawModelId: string;
  bareModelId: string;
  baseUrl: string;
  profile: ModelCapabilityProfile;
  discoveredAtIso: string;
  lastSeenAtIso: string;
  source: "remote_sync" | "configured";
  probe?: { probedAtIso: string; ok: boolean; ttftMs: number | null; toolCallingSupported: boolean | null };
  circuit: ModelCircuitState;
}

export interface ProviderSyncResult {
  providerId: string; ok: boolean; discoveredCount: number; chatModelCount: number;
  addedModels: string[]; removedModels: string[]; skippedReason?: string; error?: string; syncedAtIso: string;
}

export interface ModelPoolSnapshot {
  lastSyncedAtIso: string | null; totalModels: number; chatModels: number;
  healthyChatModels: number; coolingChatModels: number; providersSynced: number; entries: SyncedModelEntry[];
}

function writeAtomic600(filePath: string, payload: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, filePath);
}

function buildHeaders(p: ProviderRecord): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json" };
  if (p.apiKey) {
    if (p.preset === "anthropic") { h["x-api-key"] = p.apiKey; h["anthropic-version"] = "2023-06-01"; }
    else h.Authorization = `Bearer ${p.apiKey}`;
  }
  return h;
}

function defaultCircuit(): ModelCircuitState {
  return { state: "closed", consecutiveFailures: 0, cooldownUntilMs: 0 };
}

export class ModelPoolSyncer {
  private readonly filePath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly nowMs: () => number;
  private entries = new Map<string, SyncedModelEntry>();
  private lastSyncedAtMs: number | null = null;

  constructor(private readonly opts: { dataDir: string; providers: ProviderRegistry; catalog: SugentModelCatalog; fetchImpl?: typeof fetch; nowMs?: () => number }) {
    this.filePath = path.join(opts.dataDir, "sugent-routing", "model-pool.json");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.load();
    this.seedConfiguredProviders();
  }
```
```ts
  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as { lastSyncedAtIso?: string; entries?: SyncedModelEntry[] };
      this.lastSyncedAtMs = parsed.lastSyncedAtIso ? Date.parse(parsed.lastSyncedAtIso) || null : null;
      for (const e of parsed.entries ?? []) if (e?.targetId) this.entries.set(e.targetId, { ...e, profile: classifyModelProfile(e.rawModelId, this.opts.catalog) });
    } catch { /* 损坏缓存忽略重建 */ }
  }

  private save(): void {
    writeAtomic600(this.filePath, {
      version: 1,
      lastSyncedAtIso: this.lastSyncedAtMs ? new Date(this.lastSyncedAtMs).toISOString() : null,
      entries: Array.from(this.entries.values()),
    });
  }

  private seedConfiguredProviders(): void {
    const nowIso = new Date(this.nowMs()).toISOString();
    let dirty = false;
    for (const p of this.opts.providers.listProviders()) {
      if (!p.enabled) continue;
      for (const raw of p.models ?? []) {
        const targetId = `${p.id}/${raw}`;
        if (!this.entries.has(targetId)) {
          const profile = classifyModelProfile(raw, this.opts.catalog);
          this.entries.set(targetId, { targetId, providerId: p.id, rawModelId: raw, bareModelId: profile.bareModelId, baseUrl: p.baseUrl, profile, discoveredAtIso: nowIso, lastSeenAtIso: nowIso, source: "configured", circuit: defaultCircuit() });
          dirty = true;
        }
      }
    }
    if (dirty) this.save();
  }

  async syncProvider(providerId: string, opts?: { force?: boolean }): Promise<ProviderSyncResult> {
    const p = this.opts.providers.getProvider(providerId);
    const now = this.nowMs();
    const syncedAtIso = new Date(now).toISOString();
    if (!p || !p.enabled || !p.baseUrl) return { providerId, ok: false, discoveredCount: 0, chatModelCount: 0, addedModels: [], removedModels: [], skippedReason: "disabled_or_no_base_url", syncedAtIso };
    try {
      const res = await this.fetchImpl(`${p.baseUrl.replace(/\/+$/, "")}/models`, { headers: buildHeaders(p), signal: AbortSignal.timeout(8_000) });
      if (!res.ok) return { providerId, ok: false, discoveredCount: 0, chatModelCount: 0, addedModels: [], removedModels: [], error: `HTTP ${res.status}`, syncedAtIso };
      const body = (await res.json()) as { data?: Array<{ id?: unknown }>; models?: Array<{ id?: unknown; name?: unknown }> };
      const rawIds = Array.from(new Set((Array.isArray(body.data) ? body.data.map((x) => String(x.id ?? "").trim()) : Array.isArray(body.models) ? body.models.map((x) => String(x.id ?? x.name ?? "").trim()) : []).filter(Boolean)));
      const prevSet = new Set(Array.from(this.entries.values()).filter((e) => e.providerId === providerId).map((e) => e.rawModelId));
      const nextSet = new Set(rawIds);
      const addedModels = rawIds.filter((m) => !prevSet.has(m));
      const removedModels = Array.from(prevSet).filter((m) => !nextSet.has(m));
      for (const rem of removedModels) this.entries.delete(`${providerId}/${rem}`);
      for (const raw of rawIds) {
        const targetId = `${providerId}/${raw}`;
        const prev = this.entries.get(targetId);
        const profile = classifyModelProfile(raw, this.opts.catalog);
        this.entries.set(targetId, {
          targetId, providerId, rawModelId: raw, bareModelId: profile.bareModelId, baseUrl: p.baseUrl, profile,
          discoveredAtIso: prev?.discoveredAtIso ?? syncedAtIso, lastSeenAtIso: syncedAtIso, source: "remote_sync",
          ...(prev?.probe ? { probe: prev.probe } : {}),
          circuit: prev?.circuit ? { ...prev.circuit, ...(prev.circuit.needsResync ? { state: "closed", consecutiveFailures: 0, cooldownUntilMs: 0, needsResync: false } : {}) } : defaultCircuit(),
        });
      }
      if (rawIds.length > 0) this.opts.providers.upsertProvider({ id: p.id, models: rawIds, ...(p.defaultModel || !opts?.force ? {} : { defaultModel: rawIds[0] }) }, now);
      this.lastSyncedAtMs = now;
      this.save();
      const chatModelCount = rawIds.filter((r) => classifyModelProfile(r, this.opts.catalog).isChatModel).length;
      return { providerId, ok: true, discoveredCount: rawIds.length, chatModelCount, addedModels, removedModels, syncedAtIso };
    } catch (err) {
      return { providerId, ok: false, discoveredCount: 0, chatModelCount: 0, addedModels: [], removedModels: [], error: err instanceof Error ? err.message : String(err), syncedAtIso };
    }
  }
```
```ts
  async syncAllEnabled(opts?: { force?: boolean; minIntervalMs?: number }): Promise<{ results: ProviderSyncResult[]; snapshot: ModelPoolSnapshot }> {
    this.seedConfiguredProviders();
    const minInt = opts?.minIntervalMs ?? 600_000;
    const now = this.nowMs();
    if (!opts?.force && this.lastSyncedAtMs && now - this.lastSyncedAtMs < minInt) {
      return { results: [], snapshot: this.getPoolSnapshot(now) };
    }
    const results: ProviderSyncResult[] = [];
    for (const p of this.opts.providers.listProviders()) {
      if (p.enabled && p.baseUrl) results.push(await this.syncProvider(p.id, { force: opts?.force }));
    }
    return { results, snapshot: this.getPoolSnapshot(this.nowMs()) };
  }

  async probeUnknownModels(opts?: { maxProbes?: number; timeoutMs?: number }): Promise<number> {
    const limit = opts?.maxProbes ?? 2;
    const timeoutMs = opts?.timeoutMs ?? 6_000;
    let count = 0;
    for (const e of this.entries.values()) {
      if (count >= limit) break;
      if (!e.profile.isChatModel || !e.profile.inferredFromFallback || e.probe) continue;
      const p = this.opts.providers.getProvider(e.providerId);
      if (!p || !p.enabled || !p.baseUrl) continue;
      const t0 = this.nowMs();
      try {
        const res = await this.fetchImpl(`${p.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
          method: "POST",
          headers: buildHeaders(p),
          body: JSON.stringify({
            model: e.rawModelId,
            max_tokens: 16,
            messages: [{ role: "user", content: "ping" }],
            tools: [{ type: "function", function: { name: "ping", parameters: { type: "object", properties: {} } } }],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const ttftMs = Math.max(1, this.nowMs() - t0);
        const json = res.ok ? ((await res.json().catch(() => ({}))) as { choices?: Array<{ message?: { tool_calls?: unknown[] } }> }) : undefined;
        e.probe = { probedAtIso: new Date(this.nowMs()).toISOString(), ok: res.ok, ttftMs: res.ok ? ttftMs : null, toolCallingSupported: res.ok ? Boolean(json?.choices?.[0]?.message) : false };
      } catch {
        e.probe = { probedAtIso: new Date(this.nowMs()).toISOString(), ok: false, ttftMs: null, toolCallingSupported: null };
      }
      count += 1;
    }
    if (count > 0) this.save();
    return count;
  }

  recordInfraFailure(targetId: string, status: number | "timeout" | "network", atMs = this.nowMs()): ModelCircuitState {
    const entry = this.entries.get(targetId);
    const cur: ModelCircuitState = entry?.circuit ?? defaultCircuit();
    cur.consecutiveFailures += 1;
    cur.lastErrorCode = String(status);
    cur.lastFailureAtIso = new Date(atMs).toISOString();
    if (status === 429) {
      cur.state = "open";
      cur.cooldownUntilMs = atMs + 60_000 * Math.min(15, 3 ** (cur.consecutiveFailures - 1));
    } else if (status === 401 || status === 403 || status === 404) {
      cur.state = "open";
      cur.cooldownUntilMs = atMs + 1_800_000;
      if (status === 404) cur.needsResync = true;
    } else if (cur.consecutiveFailures >= 2) {
      cur.state = "open";
      cur.cooldownUntilMs = atMs + 120_000 * Math.min(5, cur.consecutiveFailures - 1);
    }
    if (entry) { entry.circuit = cur; this.save(); }
    return { ...cur };
  }

  recordInfraSuccess(targetId: string, _atMs = this.nowMs()): ModelCircuitState {
    const entry = this.entries.get(targetId);
    const next: ModelCircuitState = defaultCircuit();
    if (entry) { entry.circuit = next; this.save(); }
    return next;
  }

  isModelAvailable(targetId: string, atMs = this.nowMs()): boolean {
    const entry = this.entries.get(targetId);
    if (!entry) return true;
    if (entry.circuit.state === "open") {
      if (atMs >= entry.circuit.cooldownUntilMs) {
        entry.circuit.state = "half_open";
        this.save();
        return true;
      }
      return false;
    }
    return true;
  }

  listChatCandidates(atMs = this.nowMs()): SyncedModelEntry[] {
    this.seedConfiguredProviders();
    const enabledIds = new Set(this.opts.providers.listProviders().filter((p) => p.enabled).map((p) => p.id));
    return Array.from(this.entries.values()).filter((e) => {
      if (!enabledIds.has(e.providerId) || !e.profile.isChatModel) return false;
      this.isModelAvailable(e.targetId, atMs);
      return true;
    });
  }

  getEntry(targetId: string): SyncedModelEntry | undefined { return this.entries.get(targetId); }

  getPoolSnapshot(atMs = this.nowMs()): ModelPoolSnapshot {
    const enabledIds = new Set(this.opts.providers.listProviders().filter((p) => p.enabled).map((p) => p.id));
    const entries = Array.from(this.entries.values()).filter((e) => enabledIds.has(e.providerId));
    const chat = entries.filter((e) => e.profile.isChatModel);
    const healthy = chat.filter((e) => this.isModelAvailable(e.targetId, atMs));
    return {
      lastSyncedAtIso: this.lastSyncedAtMs ? new Date(this.lastSyncedAtMs).toISOString() : null,
      totalModels: entries.length, chatModels: chat.length, healthyChatModels: healthy.length,
      coolingChatModels: chat.length - healthy.length,
      providersSynced: new Set(entries.map((e) => e.providerId)).size,
      entries,
    };
  }
}
```

- [ ] **Step 4: 运行同步与熔断单测**

Run: `npx vitest run test/sugent-model-pool-sync.unit.test.ts < /dev/null`
Expected: PASS。

- [ ] **Step 5: 提交 Task 2**

```bash
git add src/sugent/model-pool-sync.ts test/sugent-model-pool-sync.unit.test.ts
git commit -m "feat(routing): add ModelPoolSyncer with CLIProxyAPI sync and exponential circuit breaker"
```

---

### Task 3: 在线经验账本与自然语言策略存储（`src/sugent/routing-experience-store.ts`）

**Files:**
- Create: `src/sugent/routing-experience-store.ts`
- Test: `test/sugent-adaptive-router.unit.test.ts`

**Interfaces:**
- Consumes: `fs`, `path`, `crypto`
- Produces:
  - `export type TaskArchetype = "quick_chat_capture" | "tool_orchestration" | "long_doc_synthesis" | "deep_reasoning_plan" | "coding_and_review" | "vision_gui";`
  - `export type RoutingStrategyPreset = "quota_saver" | "balanced" | "quality_first";`
  - `export type RoutingOperatingMode = "auto" | "shadow" | "pinned";`
  - `export interface ExperienceCell`, `export interface RoutingOutcomeEvent`, `export interface RoutingPolicyState`, `export interface RecordedRouteDecision`
  - `export const TASK_ARCHETYPES: readonly TaskArchetype[]`
  - `export class RoutingExperienceStore`（方法：`recordOutcome`, `getPosterior`, `getTotalArchetypeSamples`, `recordDecision`, `updateDecisionOutcome`, `getRecentDecisions`, `getDecision`, `getLeaderboardByArchetype`, `getPolicy`, `updatePolicy`, `applyNaturalLanguageDirective`, `detectImplicitUserCorrection`）

- [ ] **Step 1: 编写 `test/sugent-adaptive-router.unit.test.ts` 的经验学习与策略解析失败测试**

```ts
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
      const store = new RoutingExperienceStore({ dataDir: tmp, nowMs: () => nowMs, halfLifeDays: 14, priorStrength: 5 });

      for (let i = 0; i < 6; i++) {
        store.recordOutcome({ decisionId: `d-${i}`, targetId: "cliproxy/claude-sonnet-4-6", archetype: "coding_and_review", ok: true, ttftMs: 420, totalLatencyMs: 1200, costUsd: 0.01, signalSource: "turn_complete", atMs: nowMs });
        store.recordOutcome({ decisionId: `b-${i}`, targetId: "cliproxy/model-b", archetype: "coding_and_review", ok: false, emptyReply: true, signalSource: "quality_escalation", atMs: nowMs });
      }
      const pGood = store.getPosterior("coding_and_review", "cliproxy/claude-sonnet-4-6", 0.78, nowMs);
      const pBad = store.getPosterior("coding_and_review", "cliproxy/model-b", 0.78, nowMs);
      expect(pGood.posteriorQuality).toBeGreaterThan(0.88);
      expect(pBad.posteriorQuality).toBeLessThan(0.5);

      nowMs += 28 * 86_400_000; // 2 个半衰期后，旧样本影响力衰减 75%
      const decayed = store.getPosterior("coding_and_review", "cliproxy/model-b", 0.78, nowMs);
      expect(decayed.effectiveSamples).toBeLessThan(3);

      expect(store.detectImplicitUserCorrection({ userText: "帮我总结今天日报", atMs: nowMs - 20_000 }, "不对，你没读全重新来", nowMs)).toBe(true);
      expect(store.detectImplicitUserCorrection({ userText: "帮我记个买牛奶的待办", atMs: nowMs - 20_000 }, "顺便查下明天天气", nowMs)).toBe(false);

      const res = store.applyNaturalLanguageDirective("以后写代码优先用 claude-sonnet-4-6，禁止使用 model-b", ["cliproxy/claude-sonnet-4-6", "cliproxy/model-b"]);
      expect(res.matched).toBe(true);
      expect(res.policy.blockedModels).toContain("cliproxy/model-b");
      expect(res.policy.archetypeBoosts.coding_and_review?.["cliproxy/claude-sonnet-4-6"]).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: 运行单测确认按预期失败**

Run: `npx vitest run test/sugent-adaptive-router.unit.test.ts < /dev/null`
Expected: FAIL，找不到 `../src/sugent/routing-experience-store.js`。
- [ ] **Step 3: 创建 `src/sugent/routing-experience-store.ts`**

```ts
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type TaskArchetype =
  | "quick_chat_capture"
  | "tool_orchestration"
  | "long_doc_synthesis"
  | "deep_reasoning_plan"
  | "coding_and_review"
  | "vision_gui";

export const TASK_ARCHETYPES: readonly TaskArchetype[] = [
  "quick_chat_capture",
  "tool_orchestration",
  "long_doc_synthesis",
  "deep_reasoning_plan",
  "coding_and_review",
  "vision_gui",
] as const;

export type RoutingStrategyPreset = "quota_saver" | "balanced" | "quality_first";
export type RoutingOperatingMode = "auto" | "shadow" | "pinned";

export interface ExperienceCell {
  key: string; archetype: TaskArchetype; targetId: string;
  effectiveSamples: number; qualitySum: number;
  successCount: number; failureCount: number; toolErrorCount: number;
  escalationCount: number; userCorrectionCount: number; explicitRetryCount: number;
  ewmaTtftMs: number | null; ewmaLatencyMs: number | null; ewmaCostUsd: number;
  lastUsedAtMs: number; lastUpdatedAtMs: number;
}

export interface RoutingOutcomeEvent {
  decisionId: string; targetId: string; archetype: TaskArchetype; ok: boolean;
  ttftMs?: number; totalLatencyMs?: number; costUsd?: number;
  toolCallCount?: number; toolParseErrorCount?: number; emptyReply?: boolean; escalated?: boolean;
  signalSource: "turn_complete" | "infra_fallback" | "quality_escalation" | "user_correction" | "explicit_retry_stronger" | "vibe_gate_pass" | "vibe_gate_fail";
  weight?: number; atMs?: number;
}

export interface RoutingPolicyRule { id: string; text: string; kind: "prefer" | "avoid" | "block" | "strategy" | "pin" | "mode"; createdAtIso: string; }

export interface RoutingPolicyState {
  version: 1; strategy: RoutingStrategyPreset; mode: RoutingOperatingMode; pinnedModel?: string;
  blockedModels: string[]; archetypeBoosts: Partial<Record<TaskArchetype, Record<string, number>>>;
  rules: RoutingPolicyRule[]; updatedAtIso: string;
}

export interface RecordedRouteDecision {
  decisionId: string; atIso: string; atMs: number; archetype: TaskArchetype;
  mode: RoutingOperatingMode; strategy: RoutingStrategyPreset;
  selectedTargetId: string; rawModelId: string; providerId: string; shadowRecommendedTargetId?: string;
  reasonSummary: string; score: number; fallbackTargets: string[]; escalationTarget?: string;
  skippedCoolingModels: string[]; escalatedFrom?: string; fallbackUsedFrom?: string; userTextPreview?: string;
}
```
```ts
function writeAtomic600(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, filePath);
}

function resolveRewardAndWeight(ev: RoutingOutcomeEvent): { reward: number; weight: number } {
  const w = ev.weight;
  if (ev.signalSource === "explicit_retry_stronger") return { reward: 0.05, weight: w ?? 3.0 };
  if (ev.signalSource === "user_correction") return { reward: 0.10, weight: w ?? 2.0 };
  if (ev.signalSource === "vibe_gate_pass") return { reward: 1.0, weight: w ?? 2.5 };
  if (ev.signalSource === "vibe_gate_fail") return { reward: 0.20, weight: w ?? 2.0 };
  if (ev.signalSource === "quality_escalation" || ev.emptyReply) return { reward: 0.15, weight: w ?? 1.5 };
  if (ev.signalSource === "infra_fallback" || !ev.ok) return { reward: 0.25, weight: w ?? 0.5 };
  const toolPenalty = Math.min(0.35, (ev.toolParseErrorCount ?? 0) * 0.20);
  return { reward: Math.max(0.1, 1.0 - toolPenalty), weight: w ?? 1.0 };
}

export class RoutingExperienceStore {
  private readonly expPath: string;
  private readonly policyPath: string;
  private readonly nowMs: () => number;
  private readonly halfLifeDays: number;
  private readonly priorStrength: number;
  private cells = new Map<string, ExperienceCell>();
  private recentDecisions: RecordedRouteDecision[] = [];
  private policy: RoutingPolicyState;

  constructor(opts: { dataDir: string; nowMs?: () => number; halfLifeDays?: number; priorStrength?: number }) {
    const dir = path.join(opts.dataDir, "sugent-routing");
    this.expPath = path.join(dir, "routing-experience.json");
    this.policyPath = path.join(dir, "routing-policy.json");
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.halfLifeDays = opts.halfLifeDays ?? 14;
    this.priorStrength = opts.priorStrength ?? 5;
    this.policy = { version: 1, strategy: "balanced", mode: "auto", blockedModels: [], archetypeBoosts: {}, rules: [], updatedAtIso: new Date(this.nowMs()).toISOString() };
    this.load();
  }

  private decayFactor(elapsedMs: number): number {
    if (elapsedMs <= 0) return 1;
    const elapsedDays = elapsedMs / 86_400_000;
    return Math.exp((-Math.LN2 * elapsedDays) / this.halfLifeDays);
  }

  private load(): void {
    try {
      if (fs.existsSync(this.expPath)) {
        const parsed = JSON.parse(fs.readFileSync(this.expPath, "utf8")) as { cells?: ExperienceCell[]; recentDecisions?: RecordedRouteDecision[] };
        for (const c of parsed.cells ?? []) if (c?.key) this.cells.set(c.key, c);
        this.recentDecisions = (parsed.recentDecisions ?? []).slice(0, 60);
      }
      if (fs.existsSync(this.policyPath)) {
        const p = JSON.parse(fs.readFileSync(this.policyPath, "utf8")) as Partial<RoutingPolicyState>;
        this.policy = { ...this.policy, ...p, version: 1, blockedModels: Array.isArray(p.blockedModels) ? p.blockedModels : [], archetypeBoosts: p.archetypeBoosts ?? {}, rules: Array.isArray(p.rules) ? p.rules : [] };
      }
    } catch { /* 损坏缓存忽略重建 */ }
  }
```
```ts
  private saveExp(): void {
    writeAtomic600(this.expPath, { version: 1, cells: Array.from(this.cells.values()), recentDecisions: this.recentDecisions.slice(0, 60) });
  }

  private savePolicy(): void {
    this.policy.updatedAtIso = new Date(this.nowMs()).toISOString();
    writeAtomic600(this.policyPath, this.policy);
  }

  recordOutcome(ev: RoutingOutcomeEvent): ExperienceCell {
    const atMs = ev.atMs ?? this.nowMs();
    const key = `${ev.archetype}::${ev.targetId}`;
    const prev = this.cells.get(key) ?? {
      key, archetype: ev.archetype, targetId: ev.targetId, effectiveSamples: 0, qualitySum: 0,
      successCount: 0, failureCount: 0, toolErrorCount: 0, escalationCount: 0,
      userCorrectionCount: 0, explicitRetryCount: 0, ewmaTtftMs: null, ewmaLatencyMs: null, ewmaCostUsd: 0,
      lastUsedAtMs: atMs, lastUpdatedAtMs: atMs,
    };
    const decay = this.decayFactor(atMs - prev.lastUpdatedAtMs);
    const { reward, weight } = resolveRewardAndWeight(ev);
    const next: ExperienceCell = {
      ...prev,
      effectiveSamples: prev.effectiveSamples * decay + weight,
      qualitySum: prev.qualitySum * decay + reward * weight,
      successCount: prev.successCount + (ev.ok ? 1 : 0),
      failureCount: prev.failureCount + (ev.ok ? 0 : 1),
      toolErrorCount: prev.toolErrorCount + (ev.toolParseErrorCount ?? 0),
      escalationCount: prev.escalationCount + (ev.escalated || ev.signalSource === "quality_escalation" ? 1 : 0),
      userCorrectionCount: prev.userCorrectionCount + (ev.signalSource === "user_correction" ? 1 : 0),
      explicitRetryCount: prev.explicitRetryCount + (ev.signalSource === "explicit_retry_stronger" ? 1 : 0),
      ewmaTtftMs: ev.ttftMs !== undefined ? (prev.ewmaTtftMs === null ? ev.ttftMs : prev.ewmaTtftMs * 0.75 + ev.ttftMs * 0.25) : prev.ewmaTtftMs,
      ewmaLatencyMs: ev.totalLatencyMs !== undefined ? (prev.ewmaLatencyMs === null ? ev.totalLatencyMs : prev.ewmaLatencyMs * 0.75 + ev.totalLatencyMs * 0.25) : prev.ewmaLatencyMs,
      ewmaCostUsd: ev.costUsd !== undefined ? prev.ewmaCostUsd * 0.75 + ev.costUsd * 0.25 : prev.ewmaCostUsd,
      lastUsedAtMs: atMs,
      lastUpdatedAtMs: atMs,
    };
    this.cells.set(key, next);
    this.saveExp();
    return { ...next };
  }

  getPosterior(archetype: TaskArchetype, targetId: string, priorQuality: number, atMs = this.nowMs()) {
    const cell = this.cells.get(`${archetype}::${targetId}`);
    if (!cell) return { posteriorQuality: priorQuality, effectiveSamples: 0, reliability: 1.0, ewmaTtftMs: null, ewmaLatencyMs: null };
    const decay = this.decayFactor(atMs - cell.lastUpdatedAtMs);
    const nEff = cell.effectiveSamples * decay;
    const sumEff = cell.qualitySum * decay;
    const posteriorQuality = (this.priorStrength * priorQuality + sumEff) / (this.priorStrength + nEff);
    const total = Math.max(1, cell.successCount + cell.failureCount);
    return { posteriorQuality, effectiveSamples: nEff, reliability: (3 + cell.successCount) / (3 + total), ewmaTtftMs: cell.ewmaTtftMs, ewmaLatencyMs: cell.ewmaLatencyMs };
  }

  getTotalArchetypeSamples(archetype: TaskArchetype, atMs = this.nowMs()): number {
    let sum = 0;
    for (const c of this.cells.values()) {
      if (c.archetype === archetype) sum += c.effectiveSamples * this.decayFactor(atMs - c.lastUpdatedAtMs);
    }
    return sum;
  }

  recordDecision(rec: RecordedRouteDecision): void { this.recentDecisions.unshift(rec); if (this.recentDecisions.length > 60) this.recentDecisions.length = 60; this.saveExp(); }
  updateDecisionOutcome(decisionId: string, patch: Partial<Pick<RecordedRouteDecision, "selectedTargetId" | "rawModelId" | "escalatedFrom" | "fallbackUsedFrom" | "reasonSummary">>): void {
    const hit = this.recentDecisions.find((d) => d.decisionId === decisionId);
    if (hit) { Object.assign(hit, patch); this.saveExp(); }
  }
  getRecentDecisions(limit = 20): RecordedRouteDecision[] { return this.recentDecisions.slice(0, limit); }
  getDecision(decisionId: string): RecordedRouteDecision | undefined { return this.recentDecisions.find((d) => d.decisionId === decisionId); }
```
```ts
  getLeaderboardByArchetype(atMs = this.nowMs()) {
    const out = Object.fromEntries(TASK_ARCHETYPES.map((a) => [a, [] as Array<{ targetId: string; posteriorQuality: number; samples: number; ewmaTtftMs: number | null }>])) as Record<TaskArchetype, Array<{ targetId: string; posteriorQuality: number; samples: number; ewmaTtftMs: number | null }>>;
    for (const c of this.cells.values()) {
      const p = this.getPosterior(c.archetype, c.targetId, 0.75, atMs);
      out[c.archetype].push({ targetId: c.targetId, posteriorQuality: Number(p.posteriorQuality.toFixed(3)), samples: Number(p.effectiveSamples.toFixed(1)), ewmaTtftMs: p.ewmaTtftMs ? Math.round(p.ewmaTtftMs) : null });
    }
    for (const a of TASK_ARCHETYPES) out[a].sort((x, y) => y.posteriorQuality - x.posteriorQuality).splice(5);
    return out;
  }

  getPolicy(): RoutingPolicyState { return { ...this.policy, blockedModels: [...this.policy.blockedModels], rules: [...this.policy.rules], archetypeBoosts: structuredClone(this.policy.archetypeBoosts) }; }

  updatePolicy(patch: { strategy?: RoutingStrategyPreset; mode?: RoutingOperatingMode; pinnedModel?: string | null; blockedModels?: string[]; unblockModel?: string; resetBoosts?: boolean }): RoutingPolicyState {
    if (patch.strategy) this.policy.strategy = patch.strategy;
    if (patch.mode) this.policy.mode = patch.mode;
    if (patch.pinnedModel !== undefined) this.policy.pinnedModel = patch.pinnedModel ? patch.pinnedModel.trim() : undefined;
    if (Array.isArray(patch.blockedModels)) this.policy.blockedModels = Array.from(new Set(patch.blockedModels.map((x) => x.trim()).filter(Boolean)));
    if (patch.unblockModel) this.policy.blockedModels = this.policy.blockedModels.filter((x) => x !== patch.unblockModel);
    if (patch.resetBoosts) { this.policy.archetypeBoosts = {}; this.policy.rules = []; }
    this.savePolicy();
    return this.getPolicy();
  }

  applyNaturalLanguageDirective(text: string, knownTargetIds: string[]): { matched: boolean; summary: string; policy: RoutingPolicyState } {
    const raw = text.trim();
    const lower = raw.toLowerCase();
    const notes: string[] = [];
    const nowIso = new Date(this.nowMs()).toISOString();
    const archetypes: TaskArchetype[] = [];
    if (/(写代码|代码|开发|编程|review|coding)/.test(lower)) archetypes.push("coding_and_review");
    if (/(长文|文档|报告|复盘|总结|阅读)/.test(lower)) archetypes.push("long_doc_synthesis");
    if (/(规划|方案|架构|决策|推理)/.test(lower)) archetypes.push("deep_reasoning_plan");
    if (/(闲聊|记一笔|记账|备忘|待办)/.test(lower)) archetypes.push("quick_chat_capture");
    if (/(工具|调度|耳麦)/.test(lower)) archetypes.push("tool_orchestration");
    if (/(看图|截图|视觉|桌面)/.test(lower)) archetypes.push("vision_gui");
    const targetScopes = archetypes.length > 0 ? archetypes : [...TASK_ARCHETYPES];
    const matchedModels = knownTargetIds.filter((id) => {
      const bare = (id.includes("/") ? id.slice(id.indexOf("/") + 1) : id).toLowerCase();
      return lower.includes(id.toLowerCase()) || lower.includes(bare);
    });
    if (/(省配额|省钱|节流|quota_saver)/.test(lower)) { this.policy.strategy = "quota_saver"; notes.push("切换策略为「省配额」"); }
    else if (/(质量优先|旗舰优先|quality_first)/.test(lower)) { this.policy.strategy = "quality_first"; notes.push("切换策略为「质量优先」"); }
    else if (/(平衡策略|均衡策略|balanced)/.test(lower)) { this.policy.strategy = "balanced"; notes.push("切换策略为「平衡」"); }
    if (/(影子模式|仅观察|shadow)/.test(lower)) { this.policy.mode = "shadow"; notes.push("切换为影子观察模式"); }
    else if (/(自动模式|开启自动路由)/.test(lower)) { this.policy.mode = "auto"; notes.push("切换为全自动路由"); }
    for (const tid of matchedModels) {
      if (/(禁止|禁用|拉黑|别用|block|never)/.test(lower)) {
        if (!this.policy.blockedModels.includes(tid)) this.policy.blockedModels.push(tid);
        this.policy.rules.push({ id: `rule-${crypto.randomBytes(3).toString("hex")}`, text: raw, kind: "block", createdAtIso: nowIso });
        notes.push(`已拉黑 ${tid}`);
      } else if (/(优先|preferred|prefer)/.test(lower)) {
        for (const a of targetScopes) (this.policy.archetypeBoosts[a] ??= {})[tid] = Math.min(0.35, (this.policy.archetypeBoosts[a]?.[tid] ?? 0) + 0.18);
        this.policy.rules.push({ id: `rule-${crypto.randomBytes(3).toString("hex")}`, text: raw, kind: "prefer", createdAtIso: nowIso });
        notes.push(`在 ${targetScopes.join(",")} 中优先 ${tid}`);
      } else if (/(固定|锁定|pin)/.test(lower)) {
        this.policy.mode = "pinned"; this.policy.pinnedModel = tid;
        this.policy.rules.push({ id: `rule-${crypto.randomBytes(3).toString("hex")}`, text: raw, kind: "pin", createdAtIso: nowIso });
        notes.push(`已锁定默认模型 ${tid}`);
      }
    }
    if (notes.length > 0) this.savePolicy();
    return { matched: notes.length > 0, summary: notes.join("；"), policy: this.getPolicy() };
  }

  detectImplicitUserCorrection(prev: { userText: string; atMs: number }, nextUserText: string, atMs = this.nowMs()): boolean {
    if (atMs - prev.atMs > 90_000) return false;
    if (/(不对|重来|重新来|没读全|乱说|换.*模型|太水|不行|漏了|不是这个|答非所问|try again|wrong|incomplete)/i.test(nextUserText)) return true;
    const norm = (s: string) => s.toLowerCase().replace(/[\s\p{P}]/gu, "");
    const a = norm(prev.userText), b = norm(nextUserText);
    if (a.length < 4 || b.length < 4) return false;
    const bigrams = (s: string) => new Set(Array.from({ length: s.length - 1 }, (_, i) => s.slice(i, i + 2)));
    const sa = bigrams(a), sb = bigrams(b);
    let inter = 0; for (const g of sa) if (sb.has(g)) inter += 1;
    return inter / Math.max(1, sa.size + sb.size - inter) >= 0.65;
  }
}
```

- [ ] **Step 4: 运行经验账本单测**

Run: `npx vitest run test/sugent-adaptive-router.unit.test.ts < /dev/null`
Expected: PASS。

- [ ] **Step 5: 提交 Task 3**

```bash
git add src/sugent/routing-experience-store.ts test/sugent-adaptive-router.unit.test.ts
git commit -m "feat(routing): add Bayesian decayed RoutingExperienceStore and NL policy parser"
```

---

### Task 4: 零延迟任务原型分类器与 Contextual Bandit 路由器（`src/sugent/adaptive-router.ts`）

**Files:**
- Create: `src/sugent/adaptive-router.ts`
- Test: `test/sugent-adaptive-router.unit.test.ts`（追加测试块）

**Interfaces:**
- Consumes: `ModelPoolSyncer`, `SyncedModelEntry`（`src/sugent/model-pool-sync.ts`），`RoutingExperienceStore`, `TaskArchetype`, `RoutingStrategyPreset`, `RoutingOperatingMode`, `RoutingPolicyState`, `RecordedRouteDecision`, `TASK_ARCHETYPES`（`src/sugent/routing-experience-store.ts`），`SugentModelCatalog`, `ModelTier`, `ModelFamily`, `classifyModelProfile`（`src/sugent/model-catalog.ts`），`ProviderRegistry`（`src/sugent/provider-registry.ts`），`LocalBudgetLedger`（`src/sugent/local-budget.ts`），`CausalLedger`（`src/sugent/causal-ledger.ts`），`ModelRole`（`src/sugent/types.ts`）
- Produces:
  - `export interface RoutingRequestContext`, `export interface TaskClassification`, `export interface ResolvedRouteEndpoint`, `export interface CandidateScoreBreakdown`, `export interface RouteDecisionPlan`, `export interface AdaptiveRoutingDashboardSnapshot`
  - `export function classifyTaskArchetype(ctx: RoutingRequestContext): TaskClassification`
  - `export class AdaptiveModelRouter`（方法：`planRoute`, `recordAttemptOutcome`, `recordVibeGateFeedback`, `getDashboardSnapshot`）

- [ ] **Step 1: 在 `test/sugent-adaptive-router.unit.test.ts` 追加原型分类、硬门禁、跨家族备选与经验学习测试**

```ts
import { ProviderRegistry } from "../src/sugent/provider-registry.js";
import { SugentModelCatalog } from "../src/sugent/model-catalog.js";
import { ModelPoolSyncer } from "../src/sugent/model-pool-sync.js";
import { AdaptiveModelRouter, classifyTaskArchetype } from "../src/sugent/adaptive-router.js";

describe("AdaptiveModelRouter", () => {
  it("prunes cooling/blocked/small-context models, picks cross-family fallbacks, and shifts routing via experience", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-router-"));
    try {
      const reg = new ProviderRegistry(tmp);
      reg.upsertProvider({ id: "cp", name: "CLIProxyAPI", preset: "custom-openai", baseUrl: "http://127.0.0.1:8317/v1", apiKey: "sk-1", enabled: true, setDefault: true, models: ["gpt-5-nano", "gemini-4-argon", "claude-sonnet-4-6", "gemini-4-hydrogen-xhigh"] });
      const catalog = new SugentModelCatalog(tmp);
      const pool = new ModelPoolSyncer({ dataDir: tmp, providers: reg, catalog });
      const exp = new RoutingExperienceStore({ dataDir: tmp });
      const router = new AdaptiveModelRouter({ pool, experience: exp, providers: reg, catalog });

      expect(classifyTaskArchetype({ role: "steward", text: "记个明天买牛奶的待办" }).archetype).toBe("quick_chat_capture");
      expect(classifyTaskArchetype({ role: "steward", text: "请读取 daily_review.md 完整报告并做深度复盘", historyChars: 65_000 }).archetype).toBe("long_doc_synthesis");

      // 1. 轻任务在 balanced 下自动倾向 fast/balanced（不浪费 xhigh）
      const quickPlan = router.planRoute({ role: "steward", text: "帮我记个买咖啡的待办", hasTools: true });
      expect(quickPlan?.primary.rawModelId).toBe("gpt-5-nano");
      expect(quickPlan?.escalationTarget?.tier === "frontier" || quickPlan?.escalationTarget?.tier === "reasoning").toBe(true);

      // 2. 长上下文 (>70k chars) 剪掉 gemini-4-argon (36k 墙) 并选 1M/200k 模型，且备选跨家族
      const longPlan = router.planRoute({ role: "steward", text: "完整阅读并总结这份日报", historyChars: 80_000, hasTools: true });
      expect(longPlan?.primary.rawModelId).not.toBe("gemini-4-argon");
      expect(longPlan?.infraFallbacks.some((f) => f.family !== longPlan?.primary.family)).toBe(true);

      // 3. 持续正反馈让新候选凭历史经验反超默认候选
      for (let i = 0; i < 6; i++) {
        router.recordAttemptOutcome({ decisionId: `x-${i}`, targetId: "cp/claude-sonnet-4-6", archetype: "coding_and_review", ok: true, ttftMs: 300, signalSource: "vibe_gate_pass" });
        router.recordAttemptOutcome({ decisionId: `y-${i}`, targetId: "cp/gemini-4-hydrogen-xhigh", archetype: "coding_and_review", ok: false, emptyReply: true, signalSource: "quality_escalation" });
      }
      const codePlan = router.planRoute({ role: "executor", text: "重构 TypeScript 路由层并修 bug", hasTools: true });
      expect(codePlan?.primary.targetId).toBe("cp/claude-sonnet-4-6");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: 运行单测确认按预期失败**

Run: `npx vitest run test/sugent-adaptive-router.unit.test.ts < /dev/null`
Expected: FAIL，找不到 `../src/sugent/adaptive-router.js`。
- [ ] **Step 3: 创建 `src/sugent/adaptive-router.ts`**

```ts
import crypto from "node:crypto";
import type { CausalLedger } from "./causal-ledger.js";
import type { LocalBudgetLedger } from "./local-budget.js";
import type { ModelFamily, ModelTier, SugentModelCatalog } from "./model-catalog.js";
import type { ModelPoolSnapshot, ModelPoolSyncer, SyncedModelEntry } from "./model-pool-sync.js";
import type { ProviderRegistry } from "./provider-registry.js";
import type { RecordedRouteDecision, RoutingExperienceStore, RoutingOperatingMode, RoutingOutcomeEvent, RoutingPolicyState, RoutingStrategyPreset, TaskArchetype } from "./routing-experience-store.js";
import type { ModelRole } from "./types.js";

export interface RoutingRequestContext {
  role: ModelRole; text: string; historyChars?: number; systemPromptChars?: number;
  hasImages?: boolean; hasTools?: boolean; excludeTargetIds?: string[]; forceMinTier?: ModelTier; botId?: string;
}
export interface TaskClassification { archetype: TaskArchetype; confidence: number; estimatedInputTokens: number; signals: string[]; }
export interface ResolvedRouteEndpoint { targetId: string; providerId: string; rawModelId: string; baseUrl: string; apiKey: string; tier: ModelTier; family: ModelFamily; thoughtSignatureRequired: boolean; }
export interface CandidateScoreBreakdown { targetId: string; totalScore: number; qualityScore: number; healthScore: number; speedScore: number; effectiveCost: number; exploreBonus: number; tierAffinity: number; policyBoost: number; }
export interface RouteDecisionPlan { decisionId: string; archetype: TaskArchetype; classification: TaskClassification; mode: RoutingOperatingMode; strategy: RoutingStrategyPreset; primary: ResolvedRouteEndpoint; infraFallbacks: ResolvedRouteEndpoint[]; escalationTarget?: ResolvedRouteEndpoint; shadowRecommendedTargetId?: string; reasonSummary: string; skippedCoolingModels: string[]; scoredCandidates: CandidateScoreBreakdown[]; }
export interface AdaptiveRoutingDashboardSnapshot { mode: RoutingOperatingMode; strategy: RoutingStrategyPreset; pinnedModel?: string; pool: ModelPoolSnapshot; policy: RoutingPolicyState; recentDecisions: RecordedRouteDecision[]; leaderboard: ReturnType<RoutingExperienceStore["getLeaderboardByArchetype"]>; }

const TIER_ORDER: Record<ModelTier, number> = { fast: 0, balanced: 1, frontier: 2, reasoning: 3 };
const STRATEGY_WEIGHTS: Record<RoutingStrategyPreset, { wQ: number; wH: number; wS: number; wC: number }> = {
  quota_saver: { wQ: 0.34, wH: 0.20, wS: 0.16, wC: 0.30 },
  balanced: { wQ: 0.48, wH: 0.20, wS: 0.14, wC: 0.18 },
  quality_first: { wQ: 0.64, wH: 0.18, wS: 0.10, wC: 0.08 },
};
const ARCHETYPE_AFFINITY: Record<TaskArchetype, Record<ModelTier, number>> = {
  quick_chat_capture: { fast: 0.12, balanced: 0.04, frontier: -0.04, reasoning: -0.08 },
  tool_orchestration: { fast: -0.02, balanced: 0.06, frontier: 0.06, reasoning: 0.01 },
  long_doc_synthesis: { fast: -0.05, balanced: 0.03, frontier: 0.07, reasoning: 0.04 },
  deep_reasoning_plan: { fast: -0.10, balanced: 0.0, frontier: 0.07, reasoning: 0.09 },
  coding_and_review: { fast: -0.08, balanced: 0.01, frontier: 0.08, reasoning: 0.08 },
  vision_gui: { fast: -0.06, balanced: 0.02, frontier: 0.08, reasoning: 0.04 },
};

export function classifyTaskArchetype(ctx: RoutingRequestContext): TaskClassification {
  const txt = ctx.text.trim();
  const estTokens = Math.ceil(((ctx.systemPromptChars ?? 4_000) + (ctx.historyChars ?? 0) + txt.length) / 2.2);
  const signals: string[] = [];
  if (ctx.hasImages || ctx.role === "computer_use" || /(截图|看图|屏幕|界面|ui|screenshot|点击)/i.test(txt)) {
    signals.push("vision_or_gui");
    return { archetype: "vision_gui", confidence: 0.9, estimatedInputTokens: estTokens, signals };
  }
  if (estTokens >= 24_000 || /(完整.*报告|原文|全文|daily_review|\.md|read_authorized_file|长文|汇总全天)/i.test(txt)) {
    signals.push("long_context_or_full_doc");
    return { archetype: "long_doc_synthesis", confidence: 0.88, estimatedInputTokens: estTokens, signals };
  }
  if (ctx.role === "executor" || /(代码|源码|重构|报错|单测|编译|typecheck|worktree|vibe|commit|git|typescript|bug|fix|refactor)/i.test(txt)) {
    signals.push("coding_or_executor");
    return { archetype: "coding_and_review", confidence: 0.88, estimatedInputTokens: estTokens, signals };
  }
  if (/(为什么|怎么设计|架构|方案|规划|策划|利弊|权衡|评估|决策|strategy|architecture|plan)/i.test(txt) || txt.length >= 220) {
    signals.push("complex_reasoning");
    return { archetype: "deep_reasoning_plan", confidence: 0.82, estimatedInputTokens: estTokens, signals };
  }
  if (/(来信|回复|微信|飞书|客户|待办|目标|简报|project|session|antigravity|绑定|派发|批准|重启|日程|政务|跑腿)/i.test(txt)) {
    signals.push("tool_action");
    return { archetype: "tool_orchestration", confidence: 0.80, estimatedInputTokens: estTokens, signals };
  }
  signals.push("short_capture_or_chat");
  return { archetype: "quick_chat_capture", confidence: 0.78, estimatedInputTokens: estTokens, signals };
}
```
```ts
export class AdaptiveModelRouter {
  private readonly nowMs: () => number;

  constructor(private readonly opts: {
    pool: ModelPoolSyncer; experience: RoutingExperienceStore; providers: ProviderRegistry; catalog: SugentModelCatalog;
    localBudgets?: LocalBudgetLedger; causalLedger?: CausalLedger;
    getFallbackEndpoint?: () => { baseUrl: string; apiKey: string; model: string } | undefined; nowMs?: () => number;
  }) { this.nowMs = opts.nowMs ?? (() => Date.now()); }

  private toEndpoint(entry: SyncedModelEntry): ResolvedRouteEndpoint | undefined {
    const prov = this.opts.providers.getProvider(entry.providerId);
    if (!prov || !prov.enabled || !prov.baseUrl) return undefined;
    return { targetId: entry.targetId, providerId: prov.id, rawModelId: entry.rawModelId, baseUrl: prov.baseUrl, apiKey: prov.apiKey, tier: entry.profile.tier, family: entry.profile.family, thoughtSignatureRequired: entry.profile.thoughtSignatureRequired };
  }

  private scoreEntry(entry: SyncedModelEntry, archetype: TaskArchetype, policy: RoutingPolicyState, totalSamples: number, w: { wQ: number; wH: number; wS: number; wC: number }, costMult: number, now: number): CandidateScoreBreakdown {
    const post = this.opts.experience.getPosterior(archetype, entry.targetId, entry.profile.priorQuality, now);
    const baseSpeed = entry.profile.tier === "fast" ? 0.92 : entry.profile.tier === "balanced" ? 0.78 : entry.profile.tier === "frontier" ? 0.58 : 0.40;
    const speedScore = post.ewmaTtftMs !== null ? Math.max(0.1, Math.min(1, 1 - (post.ewmaTtftMs - 200) / 5000)) : baseSpeed;
    const usdNorm = entry.profile.rates ? Math.min(1, (entry.profile.rates.input + entry.profile.rates.output * 0.25) / 18) : 0;
    const effectiveCost = Math.min(1, Math.max(usdNorm, entry.profile.quotaScarcity * 0.85));
    const isLowRiskExplore = archetype === "quick_chat_capture" || archetype === "tool_orchestration" || archetype === "long_doc_synthesis";
    const exploreBonus = policy.mode === "auto" && isLowRiskExplore && post.effectiveSamples < 5
      ? 0.09 * Math.sqrt(Math.log(Math.max(2, totalSamples + 2)) / (post.effectiveSamples + 1)) : 0;
    const tierAffinity = ARCHETYPE_AFFINITY[archetype][entry.profile.tier];
    const policyBoost = (policy.archetypeBoosts[archetype]?.[entry.targetId] ?? 0) - (entry.circuit.state === "half_open" ? 0.08 : 0);
    const totalScore = w.wQ * post.posteriorQuality + w.wH * post.reliability + w.wS * speedScore - w.wC * costMult * effectiveCost + exploreBonus + tierAffinity + policyBoost;
    return { targetId: entry.targetId, totalScore, qualityScore: post.posteriorQuality, healthScore: post.reliability, speedScore, effectiveCost, exploreBonus, tierAffinity, policyBoost };
  }

  planRoute(ctx: RoutingRequestContext): RouteDecisionPlan | undefined {
    const now = this.nowMs();
    const policy = this.opts.experience.getPolicy();
    const cls = classifyTaskArchetype(ctx);
    const excluded = new Set([...(ctx.excludeTargetIds ?? []), ...policy.blockedModels]);
    const allChat = this.opts.pool.listChatCandidates(now);
    const skippedCoolingModels: string[] = [];
    let pool = allChat.filter((e) => {
      if (excluded.has(e.targetId) || excluded.has(e.rawModelId)) return false;
      if (!this.opts.pool.isModelAvailable(e.targetId, now)) { skippedCoolingModels.push(e.rawModelId); return false; }
      return true;
    });
    if (pool.length === 0 && allChat.length > 0) pool = allChat.filter((e) => !excluded.has(e.targetId) && !excluded.has(e.rawModelId));
    if (pool.length === 0) {
      const fb = this.opts.getFallbackEndpoint?.();
      if (!fb) return undefined;
      const p = { targetId: `default/${fb.model}`, providerId: "default", rawModelId: fb.model, baseUrl: fb.baseUrl, apiKey: fb.apiKey, tier: "balanced" as const, family: "other" as const, thoughtSignatureRequired: false };
      return { decisionId: `rt-${crypto.randomBytes(4).toString("hex")}`, archetype: cls.archetype, classification: cls, mode: policy.mode, strategy: policy.strategy, primary: p, infraFallbacks: [], reasonSummary: `回退默认配置 ${fb.model}`, skippedCoolingModels, scoredCandidates: [] };
    }
    const fitCtx = pool.filter((e) => e.profile.context * 0.85 >= cls.estimatedInputTokens);
    if (fitCtx.length > 0) pool = fitCtx;
    else pool = [...pool].sort((a, b) => b.profile.context - a.profile.context).slice(0, Math.max(1, pool.length));
    if (ctx.hasImages) { const vis = pool.filter((e) => e.profile.vision); if (vis.length > 0) pool = vis; }
    if (ctx.hasTools !== false) { const tl = pool.filter((e) => e.profile.tools); if (tl.length > 0) pool = tl; }
    if (ctx.forceMinTier) { const minOrd = TIER_ORDER[ctx.forceMinTier]; const hi = pool.filter((e) => TIER_ORDER[e.profile.tier] >= minOrd); if (hi.length > 0) pool = hi; }
    const budget = this.opts.localBudgets?.getBotBudgetStatus(ctx.botId ?? "default", now);
    const w = { ...STRATEGY_WEIGHTS[policy.strategy] };
    const costMult = budget?.enabled && budget.exhausted ? 2.0 : budget?.enabled && budget.lowReserve ? 1.5 : 1.0;
    const totalSamples = this.opts.experience.getTotalArchetypeSamples(cls.archetype, now);
    const scored = pool.map((entry) => ({ entry, breakdown: this.scoreEntry(entry, cls.archetype, policy, totalSamples, w, costMult, now) }))
      .sort((a, b) => b.breakdown.totalScore - a.breakdown.totalScore);
    let primaryEntry = scored[0]!.entry;
    let shadowRecommendedTargetId: string | undefined;
    if (policy.mode === "pinned" && policy.pinnedModel) {
      const pinHit = pool.find((e) => e.targetId === policy.pinnedModel || e.rawModelId === policy.pinnedModel);
      if (pinHit) primaryEntry = pinHit;
    } else if (policy.mode === "shadow") {
      shadowRecommendedTargetId = scored[0]!.entry.targetId;
      const defSpec = this.opts.providers.routing.steward || this.opts.providers.getDefaultProvider()?.defaultModel || "";
      const defTarget = this.opts.providers.resolveModelTarget(defSpec);
      const safeHit = pool.find((e) => e.rawModelId === defTarget.model || e.targetId === defSpec);
      if (safeHit) primaryEntry = safeHit;
    }
```
```ts
    const primary = this.toEndpoint(primaryEntry);
    if (!primary) return undefined;
    const rem = scored.filter((s) => s.entry.targetId !== primary.targetId);
    const diffFam = rem.filter((s) => s.entry.profile.family !== primary.family);
    const sameFam = rem.filter((s) => s.entry.profile.family === primary.family);
    const infraFallbacks = [...diffFam, ...sameFam].map((s) => this.toEndpoint(s.entry)).filter((x): x is ResolvedRouteEndpoint => Boolean(x)).slice(0, 2);
    const pOrd = TIER_ORDER[primaryEntry.profile.tier];
    const escEntry = rem.find((s) => TIER_ORDER[s.entry.profile.tier] > pOrd)?.entry
      ?? rem.find((s) => s.entry.profile.priorQuality > primaryEntry.profile.priorQuality)?.entry;
    const escalationTarget = escEntry ? this.toEndpoint(escEntry) : undefined;
    const topPost = this.opts.experience.getPosterior(cls.archetype, primary.targetId, primaryEntry.profile.priorQuality, now);
    const reasonSummary = `自动路由：${primary.rawModelId}（${cls.archetype} · 后验${Math.round(topPost.posteriorQuality * 100)}%${skippedCoolingModels.length ? ` · 跳过冷却 ${skippedCoolingModels.slice(0, 2).join(",")}` : ""}）`;
    const decisionId = `rt-${crypto.randomBytes(4).toString("hex")}`;
    const atIso = new Date(now).toISOString();
    this.opts.experience.recordDecision({
      decisionId, atIso, atMs: now, archetype: cls.archetype, mode: policy.mode, strategy: policy.strategy,
      selectedTargetId: primary.targetId, rawModelId: primary.rawModelId, providerId: primary.providerId,
      ...(shadowRecommendedTargetId ? { shadowRecommendedTargetId } : {}), reasonSummary,
      score: Number((scored.find((s) => s.entry.targetId === primary.targetId)?.breakdown.totalScore ?? 0).toFixed(3)),
      fallbackTargets: infraFallbacks.map((f) => f.targetId), ...(escalationTarget ? { escalationTarget: escalationTarget.targetId } : {}),
      skippedCoolingModels, userTextPreview: ctx.text.slice(0, 60),
    });
    this.opts.causalLedger?.append({ roundId: decisionId, kind: "round_triggered", at: atIso, title: `路由 · ${primary.rawModelId}`, source: "adaptive_router", eventType: cls.archetype });
    this.opts.causalLedger?.append({ roundId: decisionId, kind: "worker_claimed", at: atIso, workerId: "adaptive-router", modelRole: ctx.role, resolvedModelId: primary.targetId, summary: reasonSummary });
    return { decisionId, archetype: cls.archetype, classification: cls, mode: policy.mode, strategy: policy.strategy, primary, infraFallbacks, escalationTarget, shadowRecommendedTargetId, reasonSummary, skippedCoolingModels, scoredCandidates: scored.map((s) => s.breakdown) };
  }

  recordAttemptOutcome(ev: { decisionId: string; targetId: string; archetype: TaskArchetype; ok: boolean; httpStatus?: number | "timeout" | "network"; ttftMs?: number; totalLatencyMs?: number; costUsd?: number; toolCallCount?: number; toolParseErrorCount?: number; emptyReply?: boolean; escalatedFrom?: string; fallbackUsedFrom?: string; signalSource: RoutingOutcomeEvent["signalSource"] }): void {
    const now = this.nowMs();
    if (!ev.ok && ev.httpStatus !== undefined) this.opts.pool.recordInfraFailure(ev.targetId, ev.httpStatus, now);
    else if (ev.ok && !ev.emptyReply) this.opts.pool.recordInfraSuccess(ev.targetId, now);
    this.opts.experience.recordOutcome({ ...ev, escalated: Boolean(ev.escalatedFrom), atMs: now });
    if (ev.ok && (ev.escalatedFrom || ev.fallbackUsedFrom)) {
      const bare = ev.targetId.includes("/") ? ev.targetId.slice(ev.targetId.indexOf("/") + 1) : ev.targetId;
      this.opts.experience.updateDecisionOutcome(ev.decisionId, { selectedTargetId: ev.targetId, rawModelId: bare, ...(ev.escalatedFrom ? { escalatedFrom: ev.escalatedFrom } : {}), ...(ev.fallbackUsedFrom ? { fallbackUsedFrom: ev.fallbackUsedFrom } : {}) });
    }
  }

  recordVibeGateFeedback(passed: boolean, targetId?: string, decisionId?: string): void {
    const fallbackDec = this.opts.experience.getRecentDecisions(1)[0];
    const resolvedTarget = targetId || fallbackDec?.selectedTargetId;
    if (!resolvedTarget) return;
    this.opts.experience.recordOutcome({ decisionId: decisionId || fallbackDec?.decisionId || `vibe-${Date.now()}`, targetId: resolvedTarget, archetype: "coding_and_review", ok: passed, signalSource: passed ? "vibe_gate_pass" : "vibe_gate_fail" });
  }

  getDashboardSnapshot(): AdaptiveRoutingDashboardSnapshot {
    const policy = this.opts.experience.getPolicy();
    return { mode: policy.mode, strategy: policy.strategy, ...(policy.pinnedModel ? { pinnedModel: policy.pinnedModel } : {}), pool: this.opts.pool.getPoolSnapshot(this.nowMs()), policy, recentDecisions: this.opts.experience.getRecentDecisions(20), leaderboard: this.opts.experience.getLeaderboardByArchetype(this.nowMs()) };
  }
}
```

- [ ] **Step 4: 运行全套路由单测**

Run: `npx vitest run test/sugent-adaptive-router.unit.test.ts < /dev/null`
Expected: PASS。

- [ ] **Step 5: 提交 Task 4**

```bash
git add src/sugent/adaptive-router.ts test/sugent-adaptive-router.unit.test.ts
git commit -m "feat(routing): add AdaptiveModelRouter with task classifier and contextual bandit"
```

---

### Task 5: `StewardLlmAgent` 双层级联、Tool Loop 回合粘性与真实计费（`src/sugent/steward-llm-agent.ts`）

**Files:**
- Modify: `src/sugent/steward-llm-agent.ts:1-110,240-335,440-450,595-669`
- Test: `test/sugent-steward-adaptive-routing.e2e.unit.test.ts`

**Interfaces:**
- Consumes: `RouteDecisionPlan`, `ResolvedRouteEndpoint`, `AdaptiveRoutingDashboardSnapshot`（`src/sugent/adaptive-router.ts`），`TaskArchetype`, `RoutingOperatingMode`, `RoutingPolicyState`, `RoutingStrategyPreset`（`src/sugent/routing-experience-store.ts`），`ProviderSyncResult`（`src/sugent/model-pool-sync.ts`），`ModelTier`（`src/sugent/model-catalog.ts`）
- Produces:
  - `export interface StewardRouteMeta { decisionId: string; archetype: TaskArchetype; selectedModel: string; targetId: string; providerId: string; strategy: RoutingStrategyPreset; mode: RoutingOperatingMode; reasonSummary: string; fallbackFrom?: string; escalatedFrom?: string; skippedCoolingModels: string[]; canRetryStronger: boolean; }`
  - `StewardLlmToolsPort` 新增可选方法：`getRoutingDashboard?(): AdaptiveRoutingDashboardSnapshot; syncModelPool?(opts?: { providerId?: string; force?: boolean }): Promise<ProviderSyncResult[]>; updateRoutingPolicy?(patch: { strategy?: RoutingStrategyPreset; mode?: RoutingOperatingMode; pinnedModel?: string | null; directive?: string }): { matched?: boolean; summary?: string; policy: RoutingPolicyState };`
  - `StewardLlmAgentOptions` 新增可选钩子：`resolveRoutePlan?`, `estimateCostUsd?`, `onRouteAttemptOutcome?`
  - `runTurn(...)` 入参新增 `excludeTargetIds?: string[]; forceMinTier?: ModelTier; hasImages?: boolean`，返回值新增 `routeMeta?: StewardRouteMeta`

- [ ] **Step 1: 在 `test/sugent-steward-adaptive-routing.e2e.unit.test.ts` 编写 429 平级秒切、Gemini `thought_signature` 粘性与 Round 0 质量升档失败测试**

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { StewardLlmAgent } from "../src/sugent/steward-llm-agent.js";
import { ProviderRegistry } from "../src/sugent/provider-registry.js";
import { SugentModelCatalog } from "../src/sugent/model-catalog.js";
import { ModelPoolSyncer } from "../src/sugent/model-pool-sync.js";
import { RoutingExperienceStore } from "../src/sugent/routing-experience-store.js";
import { AdaptiveModelRouter } from "../src/sugent/adaptive-router.js";
import type { StewardWorkbenchLike } from "../src/sugent/steward-conversation.js";

const stubWb = (): StewardWorkbenchLike => ({
  callerDomain: "owner_private", quietHoursActive: false,
  ledger: { version: 1, updatedAt: "", relationships: [], goals: [], guardrails: [], commitments: [], resources: [] },
  cadence: { dateKey: "2026-11-23", state: { nonUrgentSentCount: 0, dailySoftQuota: 0, morningDigestQueue: [] } },
  antigravity: { surfacesScanned: [], totalSessions: 0, totalSubagentsFolded: 0, sessions: [], projects: [] },
});

describe("StewardLlmAgent Cascade & Intra-Turn Stickiness", () => {
  it("silently fails over on 429, escalates on empty reply, and locks Gemini thought_signature mid-tool-loop", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-agent-rt-"));
    try {
      const reg = new ProviderRegistry(tmp);
      reg.upsertProvider({ id: "cp", preset: "custom-openai", baseUrl: "http://127.0.0.1:8317/v1", apiKey: "k", enabled: true, setDefault: true, models: ["gpt-5-nano", "gemini-4-hydrogen-xhigh", "claude-sonnet-4-6"] });
      const catalog = new SugentModelCatalog(tmp);
      const pool = new ModelPoolSyncer({ dataDir: tmp, providers: reg, catalog });
      const exp = new RoutingExperienceStore({ dataDir: tmp });
      const router = new AdaptiveModelRouter({ pool, experience: exp, providers: reg, catalog });

      const calls: Array<{ model: string; hasThoughtSig?: boolean }> = [];
      const mockFetch: typeof fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { model: string; messages: Array<{ tool_calls?: Array<{ extra_content?: { google?: { thought_signature?: string } } }> }> };
        const hasSig = body.messages.some((m) => m.tool_calls?.some((tc) => tc.extra_content?.google?.thought_signature === "sig-g4"));
        calls.push({ model: body.model, hasThoughtSig: hasSig });
        if (body.model === "gpt-5-nano") return new Response("rate limit", { status: 429 });
        if (calls.filter((c) => c.model === body.model).length === 1 && !hasSig && body.model === "gemini-4-hydrogen-xhigh") {
          return new Response(JSON.stringify({ model: body.model, choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "tc-1", type: "function", function: { name: "query_personal_memory", arguments: "{\"query\":\"test\"}" }, extra_content: { google: { thought_signature: "sig-g4" } } }] } }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ model: body.model, usage: { prompt_tokens: 1000, completion_tokens: 200 }, choices: [{ message: { role: "assistant", content: "已完成查询。" } }] }), { status: 200 });
      };
      const agent = new StewardLlmAgent({
        getEndpoint: () => undefined, fetchImpl: mockFetch,
        resolveRoutePlan: (ctx) => router.planRoute(ctx),
        estimateCostUsd: (m, u) => catalog.estimateCostUsd(m, u),
        onRouteAttemptOutcome: (ev) => router.recordAttemptOutcome(ev),
        toolsPort: { getWorkbench: stubWb, queryLedger: () => ({ goals: [], commitments: [], guardrails: [], relationships: [], ledgerSummary: "" }), findArchiveResources: () => [], upsertArchiveResource: () => [], mutateCommitment: () => ({ ok: true, commitment: {} as never, workbench: stubWb() }), mutateGoal: () => ({ ok: true, workbench: stubWb() }), mutateTrust: () => ({ ok: true, workbench: stubWb() }), submitDropzone: async () => ({ ok: true, outcome: {} as never, workbench: stubWb() }), scanCadence: () => ({ emitNow: [], foldToMorningDigest: [], workbench: stubWb() }), setQuietHours: () => ({ quietHoursActive: false, workbench: stubWb() }), setProjectTier: () => ({ workbench: stubWb() }), markSessionViewed: () => ({ workbench: stubWb() }), comprehendSession: async () => ({} as never), dispatchAntigravity: async () => ({} as never) } as never,
      });
      // 1) 429 自动平级秒切：quick_chat_capture 默认选 gpt-5-nano -> 返回 429 -> 静默切换备用模型完成
      const quickOut = await agent.runTurn({ text: "帮我记个买咖啡的待办" });
      expect(quickOut.ok).toBe(true);
      if (quickOut.ok) expect(quickOut.routeMeta?.fallbackFrom).toBe("gpt-5-nano");

      // 2) 回合内 Gemini thought_signature 粘性锁定：进入 tool loop 后不切换模型
      exp.applyNaturalLanguageDirective("在 规划 中优先使用 gemini-4-hydrogen-xhigh", ["cp/gemini-4-hydrogen-xhigh"]);
      const out = await agent.runTurn({ text: "帮我规划系统架构并查记忆" });
      expect(out.ok).toBe(true);
      if (out.ok) { expect(calls.at(-1)?.model).toBe("gemini-4-hydrogen-xhigh"); expect(calls.at(-1)?.hasThoughtSig).toBe(true); }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: 运行单测确认按预期失败**

Run: `npx vitest run test/sugent-steward-adaptive-routing.e2e.unit.test.ts < /dev/null`
Expected: FAIL，提示 `resolveRoutePlan` 等选项或 `routeMeta` 尚未定义。
- [ ] **Step 3: 修改 `src/sugent/steward-llm-agent.ts` 增加 `manage_model_routing`、级联执行与回合粘性**

1) 在顶部导出 `StewardRouteMeta`，扩展 `StewardLlmToolsPort` 与 `StewardLlmAgent` 构造参数，并追加能力描述与 `LLM_TOOLS`：

```ts
export interface StewardRouteMeta {
  decisionId: string; archetype: TaskArchetype; selectedModel: string; targetId: string; providerId: string;
  strategy: RoutingStrategyPreset; mode: RoutingOperatingMode; reasonSummary: string;
  fallbackFrom?: string; escalatedFrom?: string; skippedCoolingModels: string[]; canRetryStronger: boolean;
}
```

在 `STEWARD_CAPABILITY_DESCRIPTORS` 末尾追加：
```ts
  { toolName: "manage_model_routing", title: "CLIProxyAPI 全量模型对齐与自适应路由", summary: "查看模型池与经验评分、同步全量可用模型、切换省配额/平衡/旗舰策略或设定偏好约束", whenToUse: ["同步模型池/查看当前自动选模情况/切换省钱或旗舰策略/以后某类任务优先或禁用某模型"] },
```

在 `LLM_TOOLS` 末尾与 `executeExternalTool` 分支中追加 `manage_model_routing`：
```ts
  {
    type: "function",
    function: {
      name: "manage_model_routing",
      description: "查看 CLIProxyAPI 模型池同步与自适应路由经验榜、手动触发模型全量同步，或根据主人自然语言指令调整路由策略（如优先/禁用/锁定某模型，或切换省配额/平衡/质量优先）。",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["status", "sync", "set_policy"] },
          directive: { type: "string", description: "主人的自然语言路由偏置指令" },
          strategy: { type: "string", enum: ["quota_saver", "balanced", "quality_first"] },
          mode: { type: "string", enum: ["auto", "shadow", "pinned"] },
          pinnedModel: { type: "string" },
        },
        required: ["action"],
      },
    },
  },
```

```ts
    if (name === "manage_model_routing") {
      if (act === "sync" && p.syncModelPool) return { ok: true, results: await p.syncModelPool({ force: true }), dashboard: p.getRoutingDashboard?.() };
      if (act === "set_policy" && p.updateRoutingPolicy) return { ok: true, ...p.updateRoutingPolicy({ ...(typeof args.strategy === "string" ? { strategy: args.strategy as RoutingStrategyPreset } : {}), ...(typeof args.mode === "string" ? { mode: args.mode as RoutingOperatingMode } : {}), ...(typeof args.pinnedModel === "string" ? { pinnedModel: args.pinnedModel } : {}), ...(typeof args.directive === "string" ? { directive: args.directive } : {}) }) };
      return p.getRoutingDashboard ? { ok: true, dashboard: p.getRoutingDashboard() } : { ok: false, errorCode: "ROUTING_UNAVAILABLE" };
    }
```
2) 扩展 `StewardLlmAgent` 构造参数（`resolveRoutePlan`、`estimateCostUsd`、`onRouteAttemptOutcome`）并重写 `runTurn` 支持双层级联与回合内粘性：

```ts
  private async invokeChat(ep: ResolvedRouteEndpoint, messages: Array<Record<string, unknown>>) {
    const fetchFn = this.opts.fetchImpl ?? fetch;
    const t0 = Date.now();
    try {
      const res = await fetchFn(`${ep.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ep.apiKey}`, "User-Agent": "Sugent/0.1" },
        body: JSON.stringify({ model: ep.rawModelId, messages, tools: LLM_TOOLS }),
        signal: AbortSignal.timeout(75_000),
      });
      const latencyMs = Math.max(1, Date.now() - t0);
      if (!res.ok) return { ok: false as const, status: res.status, latencyMs, err: `HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}` };
      const data = (await res.json()) as { model?: string; usage?: { prompt_tokens?: number; completion_tokens?: number }; choices?: Array<{ message?: { role?: string; content?: string | null; tool_calls?: Array<{ id: string; type?: string; function?: { name?: string; arguments?: string }; extra_content?: unknown }> } }> };
      return { ok: true as const, data, latencyMs };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false as const, status: /abort|timeout/i.test(msg) ? ("timeout" as const) : ("network" as const), latencyMs: Math.max(1, Date.now() - t0), err: msg };
    }
  }
```

```ts
  async runTurn(input: { text: string; history?: Array<{ role: "user" | "assistant"; content: string }>; callerDomain?: CallerAccessDomain; channel?: DropzoneChannel; excludeTargetIds?: string[]; forceMinTier?: ModelTier; hasImages?: boolean }): Promise<{ ok: true; reply: string; modelUsed: string; toolCallsExecuted: string[]; routeMeta?: StewardRouteMeta; workbench: TWorkbench } | { ok: false; fallbackReason: string }> {
    this.turnSeq += 1;
    const domain: CallerAccessDomain = input.callerDomain ?? "owner_private";
    const channel: DropzoneChannel = input.channel ?? "web_ui";
    const wb = this.opts.toolsPort.getWorkbench(domain);
    const sysPrompt = buildSystemPrompt(wb);
    const histMsgs = (input.history ?? []).slice(-10).map((m) => ({ role: m.role, content: m.content }));
    const baseMessages: Array<Record<string, unknown>> = [{ role: "system", content: sysPrompt }, ...histMsgs, { role: "user", content: input.text }];
    const legacy = this.opts.getEndpoint();
    const plan: RouteDecisionPlan | undefined = this.opts.resolveRoutePlan?.({ role: "steward", text: input.text, historyChars: histMsgs.reduce((s, m) => s + m.content.length, 0), systemPromptChars: sysPrompt.length, hasImages: input.hasImages, hasTools: true, excludeTargetIds: input.excludeTargetIds, forceMinTier: input.forceMinTier })
      ?? (legacy?.baseUrl && legacy.apiKey ? { decisionId: `rt-leg-${this.turnSeq}`, archetype: "tool_orchestration", classification: { archetype: "tool_orchestration", confidence: 1, estimatedInputTokens: 1000, signals: [] }, mode: "auto", strategy: "balanced", primary: { targetId: `default/${legacy.model}`, providerId: "default", rawModelId: legacy.model, baseUrl: legacy.baseUrl, apiKey: legacy.apiKey, tier: "balanced", family: "other", thoughtSignatureRequired: false }, infraFallbacks: [], reasonSummary: `固定模型 ${legacy.model}`, skippedCoolingModels: [], scoredCandidates: [] } : undefined);
    if (!plan) return { ok: false, fallbackReason: "no_endpoint" };
    const knownTools = new Set(LLM_TOOLS.map((t) => t.function.name));
    const round0Queue = [plan.primary, ...plan.infraFallbacks];
    let lockedEp: ResolvedRouteEndpoint | undefined, messages = baseMessages.map((m) => ({ ...m })), toolCallsExecuted: string[] = [];
    let totalCostUsd = 0, toolParseErrors = 0, fallbackFrom: string | undefined, escalatedFrom: string | undefined, escalationTried = false, lastErr = "no_endpoint";
    const accountUsage = (modelId: string, usage?: { prompt_tokens?: number; completion_tokens?: number }) => {
      if (!usage || !this.opts.recordUsageUsd) return;
      const usd = this.opts.estimateCostUsd?.(modelId, { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens })
        ?? (((usage.prompt_tokens ?? 0) * 3 + (usage.completion_tokens ?? 0) * 15) / 1_000_000);
      if (usd > 0) { totalCostUsd += usd; this.opts.recordUsageUsd(usd); }
    };

    const tryQueue = [...round0Queue];
    for (let qi = 0; qi < tryQueue.length; qi++) {
      const cand = tryQueue[qi]!;
      const res = await this.invokeChat(cand, messages);
      if (!res.ok) {
        lastErr = res.err;
        this.opts.onRouteAttemptOutcome?.({ decisionId: plan.decisionId, targetId: cand.targetId, archetype: plan.archetype, ok: false, httpStatus: res.status, signalSource: "infra_fallback" });
        fallbackFrom ??= cand.rawModelId;
        continue;
      }
      const msg = res.data.choices?.[0]?.message;
      const calls = msg?.tool_calls;
      let badTool = false;
      if (calls?.length) {
        for (const tc of calls) {
          if (!knownTools.has(String(tc.function?.name ?? ""))) { badTool = true; toolParseErrors += 1; }
          try { JSON.parse(String(tc.function?.arguments ?? "{}")); } catch { badTool = true; toolParseErrors += 1; }
        }
      }
      const emptyText = !calls?.length && !String(msg?.content ?? "").trim();
      if (!msg || emptyText || badTool) {
        lastErr = !msg ? "empty_choice" : emptyText ? "empty_reply" : "malformed_tool_call";
        this.opts.onRouteAttemptOutcome?.({ decisionId: plan.decisionId, targetId: cand.targetId, archetype: plan.archetype, ok: false, emptyReply: !msg || emptyText, toolParseErrorCount: badTool ? toolParseErrors : 0, signalSource: "quality_escalation" });
        if (!escalationTried && plan.escalationTarget && plan.escalationTarget.targetId !== cand.targetId) {
          escalationTried = true; escalatedFrom = cand.rawModelId; tryQueue.splice(qi + 1, 0, plan.escalationTarget);
        }
        continue;
      }
      accountUsage(res.data.model || cand.rawModelId, res.data.usage);
      lockedEp = cand;
      if (!calls?.length) {
        this.opts.onRouteAttemptOutcome?.({ decisionId: plan.decisionId, targetId: cand.targetId, archetype: plan.archetype, ok: true, ttftMs: res.latencyMs, totalLatencyMs: res.latencyMs, costUsd: totalCostUsd, toolCallCount: 0, escalatedFrom, fallbackUsedFrom: fallbackFrom, signalSource: "turn_complete" });
        return { ok: true, reply: String(msg.content ?? "").trim(), modelUsed: res.data.model || cand.rawModelId, toolCallsExecuted, routeMeta: { decisionId: plan.decisionId, archetype: plan.archetype, selectedModel: cand.rawModelId, targetId: cand.targetId, providerId: cand.providerId, strategy: plan.strategy, mode: plan.mode, reasonSummary: plan.reasonSummary, ...(fallbackFrom ? { fallbackFrom } : {}), ...(escalatedFrom ? { escalatedFrom } : {}), skippedCoolingModels: plan.skippedCoolingModels, canRetryStronger: Boolean(plan.escalationTarget) }, workbench: this.opts.toolsPort.getWorkbench(domain) };
      }
      messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: calls });
      for (const tc of calls) { const fn = String(tc.function?.name ?? ""); toolCallsExecuted.push(fn); let parsedArgs: Record<string, unknown> = {}; try { parsedArgs = JSON.parse(String(tc.function?.arguments ?? "{}")); } catch { parsedArgs = {}; } messages.push({ role: "tool", tool_call_id: tc.id, name: fn, content: JSON.stringify(await this.executeTool(fn, parsedArgs, domain, channel)) }); }
      break;
    }
    if (!lockedEp) return { ok: false, fallbackReason: lastErr };
    for (let round = 1; round < 5; round++) {
      const res = await this.invokeChat(lockedEp, messages); // 回合内严禁跨模型切换（保护 Gemini 4 thought_signature）
      if (!res.ok) return { ok: false, fallbackReason: res.err };
      accountUsage(res.data.model || lockedEp.rawModelId, res.data.usage);
      const msg = res.data.choices?.[0]?.message;
      if (!msg) return { ok: false, fallbackReason: "empty_choice" };
      if (!msg.tool_calls?.length) {
        const reply = String(msg.content ?? "").trim();
        if (!reply) return { ok: false, fallbackReason: "empty_reply" };
        this.opts.onRouteAttemptOutcome?.({ decisionId: plan.decisionId, targetId: lockedEp.targetId, archetype: plan.archetype, ok: true, ttftMs: res.latencyMs, totalLatencyMs: res.latencyMs, costUsd: totalCostUsd, toolCallCount: toolCallsExecuted.length, escalatedFrom, fallbackUsedFrom: fallbackFrom, signalSource: "turn_complete" });
        return { ok: true, reply, modelUsed: res.data.model || lockedEp.rawModelId, toolCallsExecuted, routeMeta: { decisionId: plan.decisionId, archetype: plan.archetype, selectedModel: lockedEp.rawModelId, targetId: lockedEp.targetId, providerId: lockedEp.providerId, strategy: plan.strategy, mode: plan.mode, reasonSummary: plan.reasonSummary, ...(fallbackFrom ? { fallbackFrom } : {}), ...(escalatedFrom ? { escalatedFrom } : {}), skippedCoolingModels: plan.skippedCoolingModels, canRetryStronger: Boolean(plan.escalationTarget) }, workbench: this.opts.toolsPort.getWorkbench(domain) };
      }
      messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls });
      for (const tc of msg.tool_calls) { const fn = String(tc.function?.name ?? ""); toolCallsExecuted.push(fn); let parsedArgs: Record<string, unknown> = {}; try { parsedArgs = JSON.parse(String(tc.function?.arguments ?? "{}")); } catch { parsedArgs = {}; } messages.push({ role: "tool", tool_call_id: tc.id, name: fn, content: JSON.stringify(await this.executeTool(fn, parsedArgs, domain, channel)) }); }
    }
    return { ok: false, fallbackReason: "max_tool_rounds_exceeded" };
  }
```

- [ ] **Step 4: 运行 `StewardLlmAgent` 级联与粘性测试**

Run: `npx vitest run test/sugent-steward-adaptive-routing.e2e.unit.test.ts test/sugent-steward-llm-agent.unit.test.ts < /dev/null`
Expected: PASS。

- [ ] **Step 5: 提交 Task 5**

```bash
git add src/sugent/steward-llm-agent.ts test/sugent-steward-adaptive-routing.e2e.unit.test.ts
git commit -m "feat(routing): wire two-tier cascade, thought_signature lock, and routing tool into StewardLlmAgent"
```

---

### Task 6: 宿主服务、`App`、启动脚本与构建清单全量接线

**Files:**
- Modify: `src/sugent/steward-host-service.ts:82-169,324-596,743-789,1104-1140`
- Modify: `src/sugent/index.ts:45-53`
- Modify: `src/app.ts:268-308,563-625,670-680,1008-1075`
- Modify: `scripts/start-jarvis-workbench.mjs:33-41,90-108`
- Modify: `scripts/write-build-manifest.mjs:28-33`
- Test: `test/sugent-steward-adaptive-routing.e2e.unit.test.ts`（追加宿主集成测试）

**Interfaces:**
- Consumes: `ModelPoolSyncer`（`src/sugent/model-pool-sync.ts`），`RoutingExperienceStore`（`src/sugent/routing-experience-store.ts`），`AdaptiveModelRouter`, `AdaptiveRoutingDashboardSnapshot`（`src/sugent/adaptive-router.ts`），`StewardRouteMeta`（`src/sugent/steward-llm-agent.ts`）
- Produces:
  - `SugentStewardHostService` 新增公开方法：`syncModelPool(opts?: { providerId?: string; force?: boolean }): Promise<ProviderSyncResult[]>`, `getRoutingDashboard(): AdaptiveRoutingDashboardSnapshot`, `updateRoutingPolicy(patch: { strategy?: RoutingStrategyPreset; mode?: RoutingOperatingMode; pinnedModel?: string | null; blockedModels?: string[]; unblockModel?: string; resetBoosts?: boolean; directive?: string })`, `retryLastTurnStronger(callerDomain?: CallerAccessDomain)`
  - `App` 新增公开方法：`syncProviderModels(providerId?: string, force?: boolean): Promise<ProviderSyncResult[]>`

- [ ] **Step 1: 在 `test/sugent-steward-adaptive-routing.e2e.unit.test.ts` 追加宿主隐式纠偏、手动重试更强模型与 Vibe 门禁回报失败测试**

```ts
import { SugentKnowledgeGraph } from "../src/sugent/knowledge-graph.js";
import { LocalBudgetLedger } from "../src/sugent/local-budget.js";
import { SugentStewardHostService } from "../src/sugent/steward-host-service.js";

describe("StewardHostService Adaptive Routing Integration", () => {
  it("supports CLIProxyAPI pool sync, implicit 90s correction penalty, and retryLastTurnStronger", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-host-rt-"));
    try {
      const reg = new ProviderRegistry(tmp);
      reg.upsertProvider({ id: "cp", preset: "custom-openai", baseUrl: "http://127.0.0.1:8317/v1", apiKey: "k", enabled: true, setDefault: true });
      const catalog = new SugentModelCatalog(tmp);
      let nowMs = 1_700_000_000_000;
      const mockFetch: typeof fetch = async (url, init) => {
        if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "gpt-5-nano" }, { id: "claude-sonnet-4-6" }, { id: "gemini-4-hydrogen-xhigh" }] }), { status: 200 });
        const body = JSON.parse(String(init?.body ?? "{}")) as { model: string };
        return new Response(JSON.stringify({ model: body.model, usage: { prompt_tokens: 400, completion_tokens: 80 }, choices: [{ message: { role: "assistant", content: `reply by ${body.model}` } }] }), { status: 200 });
      };
      const svc = new SugentStewardHostService({ dataDir: tmp, homeDir: tmp, knowledgeGraph: new SugentKnowledgeGraph(path.join(tmp, "kg")), localBudgets: new LocalBudgetLedger(tmp), providerRegistry: reg, modelCatalog: catalog, llmFetch: mockFetch });
      const syncRes = await svc.syncModelPool({ providerId: "cp", force: true });
      expect(syncRes[0]?.chatModelCount).toBe(3);

      const t1 = await svc.converse({ text: "帮我记个买菜待办" });
      expect(t1.modelUsed).toBe("gpt-5-nano");

      const retry = await svc.retryLastTurnStronger("owner_private");
      expect(retry.ok).toBe(true);
      expect(retry.modelUsed).not.toBe("gpt-5-nano");
      const dash = svc.getRoutingDashboard();
      expect(dash.recentDecisions.length).toBeGreaterThanOrEqual(2);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: 运行宿主集成单测确认失败**

Run: `npx vitest run test/sugent-steward-adaptive-routing.e2e.unit.test.ts < /dev/null`
Expected: FAIL，提示 `syncModelPool` / `retryLastTurnStronger` 尚未实现。
- [ ] **Step 3: 实现 `steward-host-service.ts`、`src/sugent/index.ts`、`src/app.ts` 与脚本接线**

1) 在 `src/sugent/index.ts` 末尾补充导出：
```ts
export * from "./model-pool-sync.js";
export * from "./routing-experience-store.js";
export * from "./adaptive-router.js";
```

2) 在 `src/sugent/steward-host-service.ts`：
- 为 `SugentStewardHostServiceOptions` 增加 `modelCatalog?: SugentModelCatalog;`，为 `StewardWorkbenchSnapshot` 增加 `routing?: AdaptiveRoutingDashboardSnapshot;`。
- 在构造器中初始化 `modelCatalog`、`poolProviders`（复用 `opts.providerRegistry ?? new ProviderRegistry(opts.dataDir)`）、`modelPoolSync`、`routingExperience`、`adaptiveRouter`，并把以下选项传入 `new StewardLlmAgent({ ... })`：

```ts
    this.modelCatalog = opts.modelCatalog ?? new SugentModelCatalog(opts.dataDir);
    const registryForPool = opts.providerRegistry ?? new ProviderRegistry(opts.dataDir);
    this.modelPoolSync = new ModelPoolSyncer({ dataDir: opts.dataDir, providers: registryForPool, catalog: this.modelCatalog, fetchImpl: opts.llmFetch });
    this.routingExperience = new RoutingExperienceStore({ dataDir: opts.dataDir });
    this.adaptiveRouter = new AdaptiveModelRouter({
      pool: this.modelPoolSync, experience: this.routingExperience, providers: registryForPool, catalog: this.modelCatalog,
      localBudgets: opts.localBudgets, causalLedger: this.causalLedger, getFallbackEndpoint: () => this.resolveLiveLlmEndpoint(),
    });
```

在 `new StewardLlmAgent({ ... })` 中传入：
```ts
      resolveRoutePlan: (ctx) => this.adaptiveRouter.planRoute(ctx),
      estimateCostUsd: (model, usage) => this.modelCatalog.estimateCostUsd(model, usage),
      onRouteAttemptOutcome: (ev) => this.adaptiveRouter.recordAttemptOutcome(ev),
```
并在 `toolsPort` 中挂载 `getRoutingDashboard: () => this.getRoutingDashboard()`、`syncModelPool: (o) => this.syncModelPool(o)`、`updateRoutingPolicy: (patch) => this.updateRoutingPolicy(patch)`，并在 `getWorkbench` 中返回 `routing: this.getRoutingDashboard()`。

在 `SugentStewardHostService` 中实现 4 个宿主路由方法及隐式纠偏/门禁回流：
```ts
  async syncModelPool(opts?: { providerId?: string; force?: boolean }): Promise<ProviderSyncResult[]> {
    if (opts?.providerId) return [await this.modelPoolSync.syncProvider(opts.providerId, { force: opts.force })];
    return (await this.modelPoolSync.syncAllEnabled({ force: opts?.force })).results;
  }
  getRoutingDashboard(): AdaptiveRoutingDashboardSnapshot { return this.adaptiveRouter.getDashboardSnapshot(); }
  updateRoutingPolicy(patch: { strategy?: RoutingStrategyPreset; mode?: RoutingOperatingMode; pinnedModel?: string | null; blockedModels?: string[]; unblockModel?: string; resetBoosts?: boolean; directive?: string }) {
    if (patch.directive) {
      const known = this.modelPoolSync.listChatCandidates().map((e) => e.targetId);
      const res = this.routingExperience.applyNaturalLanguageDirective(patch.directive, known);
      return { ...res, dashboard: this.getRoutingDashboard() };
    }
    const policy = this.routingExperience.updatePolicy(patch);
    return { matched: true, policy, dashboard: this.getRoutingDashboard() };
  }
  async retryLastTurnStronger(callerDomain: CallerAccessDomain = "owner_private") {
    const prev = this.lastRouteTurn;
    if (!prev) return { ok: false as const, errorCode: "NO_PREVIOUS_TURN", workbench: this.getWorkbench(callerDomain) };
    this.adaptiveRouter.recordAttemptOutcome({ decisionId: prev.decisionId, targetId: prev.targetId, archetype: prev.archetype, ok: false, signalSource: "explicit_retry_stronger" });
    const tierUp: ModelTier = prev.tier === "fast" ? "balanced" : prev.tier === "balanced" ? "frontier" : "reasoning";
    const out = await this.llmAgent.runTurn({ text: prev.text, history: prev.history, callerDomain, channel: prev.channel, excludeTargetIds: [prev.targetId], forceMinTier: tierUp });
    if (!out.ok) return { ok: false as const, errorCode: out.fallbackReason, workbench: this.getWorkbench(callerDomain) };
    this.lastRouteTurn = { ...prev, decisionId: out.routeMeta?.decisionId ?? prev.decisionId, targetId: out.routeMeta?.targetId ?? prev.targetId, tier: tierUp };
    return { ok: true as const, intent: "llm_agent" as const, reply: out.reply, modelUsed: out.modelUsed, routeMeta: out.routeMeta, workbench: out.workbench };
  }
```
在 `SugentStewardHostService.converse` 头部检测 90s 隐式纠偏、在成功后刷新 `this.lastRouteTurn`，并在 `advanceVibePipeline` / `decideVibeTask` 验证完成时把门禁成败回灌 `adaptiveRouter.recordVibeGateFeedback(...)`：
```ts
    if (this.lastRouteTurn && this.routingExperience.detectImplicitUserCorrection({ userText: this.lastRouteTurn.text, atMs: this.lastRouteTurn.atMs }, input.text)) {
      this.adaptiveRouter.recordAttemptOutcome({ decisionId: this.lastRouteTurn.decisionId, targetId: this.lastRouteTurn.targetId, archetype: this.lastRouteTurn.archetype, ok: false, signalSource: "user_correction" });
    }
    const llmOut = await this.llmAgent.runTurn({ text: input.text, history: input.history, callerDomain: input.callerDomain, channel: input.channel });
    if (llmOut.ok) {
      if (llmOut.routeMeta) {
        const entry = this.modelPoolSync.getEntry(llmOut.routeMeta.targetId);
        this.lastRouteTurn = { text: input.text, history: input.history, channel: input.channel, decisionId: llmOut.routeMeta.decisionId, targetId: llmOut.routeMeta.targetId, archetype: llmOut.routeMeta.archetype, tier: entry?.profile.tier ?? "balanced", atMs: Date.now() };
      }
      return { ok: true, intent: "llm_agent", reply: llmOut.reply, workbench: llmOut.workbench, modelUsed: llmOut.modelUsed, toolCallsExecuted: llmOut.toolCallsExecuted, routeMeta: llmOut.routeMeta };
    }
```
在 `advanceVibePipeline` 验证完成分支后补上 Vibe Coding 门禁回流：
```ts
    } else if (target.stage === "developing") {
      updated = await this.vibePipeline.runVerificationAndPackage(target.pipelineId, { extraArtifactPaths: input.extraArtifactPaths, changedFilesOverride: input.changedFilesOverride });
      if (updated && (updated.stage === "completed" || updated.stage === "awaiting_restart_approval" || updated.stage === "failed")) {
        this.adaptiveRouter.recordVibeGateFeedback(updated.stage !== "failed");
      }
```
```

3) 在 `src/app.ts`：
- 传入 `modelCatalog: this.modelCatalog` 到 `new SugentStewardHostService({ ... })`；
- 新增 `async syncProviderModels(providerId?: string, force = false) { return this.stewardService.syncModelPool({ ...(providerId ? { providerId } : {}), force }); }`；
- 在 `upsertDecoupledProvider` 成功保存到 `this.providers` 后（若 `saved.baseUrl` 且 `saved.enabled`），调用 `await this.syncProviderModels(saved.id, true).catch(() => [])` 并优先使用同步到的 `models`；
- 在 `start()` 尾部非阻塞触发 `void this.syncProviderModels(undefined, false).catch(() => {})` 与 `setInterval` 10 分钟定时刷新（`.unref()` 且在 `stop()` 中清理）。

4) 在 `scripts/start-jarvis-workbench.mjs`：
- 接入 CLIProxyAPI（`liveGatewayEnabled`）时**不再写死** `[m, "gemini-4-hydrogen-xhigh"]` 列表，先注册网关再调用 `await app.syncProviderModels("custom-gateway", true)` 拉取全量可用模型：
```js
if (liveGatewayEnabled) {
  const m = stewardModel || "gemini-4-neon-xhigh";
  await app.upsertDecoupledProvider({
    id: "custom-gateway",
    name: "CLIProxyAPI 云端推理网关",
    preset: "custom-openai",
    baseUrl: gatewayUrl,
    apiKey: gatewayKey,
    defaultModel: m,
    setDefault: true,
  });
  await app.syncProviderModels("custom-gateway", true).catch(() => []);
}
```
并将 `demoModels.listModels()` 改为优先读取 `appRef?.stewardService?.getRoutingDashboard().pool.entries.filter((e) => e.profile.isChatModel).map((e) => e.rawModelId)`，未同步到时才回退静态默认列表。

5) 在 `scripts/write-build-manifest.mjs` 的 `capabilityHighlights` 追加：`"CLIProxyAPI 全量可用模型自动同步与经验驱动自适应选模（平衡策略 + 熔断秒切 + 质量升档）"`。

- [ ] **Step 4: 运行编译与集成单测**

Run: `npm run typecheck && npx vitest run test/sugent-steward-adaptive-routing.e2e.unit.test.ts < /dev/null`
Expected: 0 类型错误且全部测试 PASS。

- [ ] **Step 5: 提交 Task 6**

```bash
git add src/sugent/steward-host-service.ts src/sugent/index.ts src/app.ts scripts/start-jarvis-workbench.mjs scripts/write-build-manifest.mjs test/sugent-steward-adaptive-routing.e2e.unit.test.ts
git commit -m "feat(routing): integrate adaptive routing and CLIProxyAPI sync across host service and app boot"
```

---

### Task 7: Web API 端点、极简管家看板与双语文案对齐

**Files:**
- Modify: `src/web/server.ts:334-360,625-645`
- Modify: `ui/components/jarvis-workbench.js:110-140,220-243`
- Modify: `ui/components/provider-settings.js:176-187,298-320`
- Modify: `ui/locales/zh-CN/steward.js:80-95`
- Modify: `ui/locales/en/steward.js:80-95`
- Modify: `ui/locales/zh-CN/onboarding.js:95-105`
- Modify: `ui/locales/en/onboarding.js:95-105`
- Test: `test/sugent-steward-adaptive-routing.e2e.unit.test.ts`（追加 Web API 集成测试）

**Interfaces:**
- Consumes: `app.syncProviderModels`, `app.stewardService.getRoutingDashboard`, `app.stewardService.updateRoutingPolicy`, `app.stewardService.syncModelPool`, `app.stewardService.retryLastTurnStronger`
- Produces:
  - `POST /amb/api/providers/sync-models`
  - `GET /amb/api/steward/routing`
  - `PUT /amb/api/steward/routing/policy`
  - `POST /amb/api/steward/routing/sync`
  - `POST /amb/api/steward/routing/retry-stronger`

- [ ] **Step 1: 在 `test/sugent-steward-adaptive-routing.e2e.unit.test.ts` 追加真实 Web HTTP 端点集成测试**

```ts
import { App } from "../src/app.js";
import { loadConfig } from "../src/config.js";

describe("Steward & Provider Adaptive Routing HTTP API", () => {
  it("exposes /providers/sync-models and /steward/routing/* endpoints end-to-end", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-web-rt-"));
    const app = new App(loadConfig({ dataDir: tmp, env: { AMB_AGENT: "off", AMB_UI_PORT: "0" } }), { printQrToTerminal: false, fileLog: false });
    await app.start();
    try {
      const base = app.web!.url;
      await app.upsertDecoupledProvider({ id: "cp", preset: "custom-openai", baseUrl: "http://127.0.0.1:8317/v1", apiKey: "k", models: ["gpt-5-nano", "claude-sonnet-4-6"], defaultModel: "claude-sonnet-4-6", setDefault: true });

      const r1 = await fetch(`${base}/amb/api/steward/routing`);
      expect(r1.status).toBe(200);
      const d1 = (await r1.json()) as { strategy: string; pool: { chatModels: number } };
      expect(d1.strategy).toBe("balanced");
      expect(d1.pool.chatModels).toBeGreaterThanOrEqual(2);

      const r2 = await fetch(`${base}/amb/api/steward/routing/policy`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ strategy: "quality_first", mode: "shadow" }) });
      expect(r2.status).toBe(200);
      const d2 = (await r2.json()) as { policy: { strategy: string; mode: string } };
      expect(d2.policy.strategy).toBe("quality_first");
      expect(d2.policy.mode).toBe("shadow");
    } finally {
      await app.stop();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: 运行 HTTP API 集成测试确认失败**

Run: `npx vitest run test/sugent-steward-adaptive-routing.e2e.unit.test.ts < /dev/null`
Expected: FAIL，`/amb/api/steward/routing` 返回 404。
- [ ] **Step 3: 实现 `src/web/server.ts` 路由端点、极简看板与服务商设置面板**

1) 在 `src/web/server.ts` 的 `if (seg[0] === "providers")` 块内（第 337 行后）新增：
```ts
      if (seg.length === 2 && seg[1] === "sync-models" && m === "POST") {
        const b = await readJson(req);
        const results = await app.syncProviderModels(typeof b.providerId === "string" ? b.providerId : undefined, b.force !== false);
        return send(res, 200, { ok: true, results, routing: app.stewardService.getRoutingDashboard(), ...app.providers.publicView(), models: await app.runtime.listModels(true).catch(() => [] as string[]) });
      }
```
在 `if (seg[0] === "steward")` 块内（第 631 行后）新增：
```ts
      if (sub === "routing" && m === "GET") {
        return send(res, 200, app.stewardService.getRoutingDashboard());
      }
      if (sub === "routing/policy" && m === "PUT") {
        const b = await readJson(req);
        return send(res, 200, app.stewardService.updateRoutingPolicy({
          ...(typeof b.strategy === "string" ? { strategy: b.strategy } : {}),
          ...(typeof b.mode === "string" ? { mode: b.mode } : {}),
          ...(b.pinnedModel !== undefined ? { pinnedModel: b.pinnedModel ? String(b.pinnedModel) : null } : {}),
          ...(Array.isArray(b.blockedModels) ? { blockedModels: b.blockedModels.map(String) } : {}),
          ...(typeof b.unblockModel === "string" ? { unblockModel: b.unblockModel } : {}),
          ...(typeof b.resetBoosts === "boolean" ? { resetBoosts: b.resetBoosts } : {}),
          ...(typeof b.directive === "string" ? { directive: b.directive } : {}),
        }));
      }
      if (sub === "routing/sync" && m === "POST") {
        const b = await readJson(req);
        const results = await app.stewardService.syncModelPool({ ...(typeof b.providerId === "string" ? { providerId: b.providerId } : {}), force: b.force !== false });
        return send(res, 200, { ok: true, results, routing: app.stewardService.getRoutingDashboard() });
      }
      if (sub === "routing/retry-stronger" && m === "POST") {
        const b = await readJson(req);
        return send(res, 200, await app.stewardService.retryLastTurnStronger(b.callerDomain ?? domain));
      }
```

2) 在 `ui/components/jarvis-workbench.js` 的 `StewardHubScreen` 中追加紧凑“智能路由与模型池”卡片（保持 zero-friction 极简呈现：3 档策略 `PUT` 切换 `quota_saver / balanced / quality_first`、影子/自动模式切换、`同步模型池`、`换更强模型重试` 与已学习原型经验榜）：
```js
const rt = wb?.routing;
const rtDecs = (rt?.recentDecisions || []).slice(0, 4);
const rtBoard = Object.entries(rt?.leaderboard || {}).filter(([, rows]) => Array.isArray(rows) && rows.length > 0).slice(0, 3);
const setRoutingPolicy = async (patch, msg) => {
  setBusy(true);
  try { await api("/steward/routing/policy", { method: "PUT", body: patch }); await refresh(); if (msg) toast(msg); }
  catch (e) { failed(e); } finally { setBusy(false); }
};
```
```js
      ${rt && html`<${HubCard} title=${t("steward.hub.routingTitle")} hint=${t("steward.hub.routingHint", { healthy: rt.pool?.healthyChatModels ?? 0, total: rt.pool?.chatModels ?? 0, cooling: rt.pool?.coolingChatModels ?? 0 })}>
        <div class="sg-actions">
          ${[["quota_saver", "steward.hub.strategyQuota"], ["balanced", "steward.hub.strategyBalanced"], ["quality_first", "steward.hub.strategyQuality"]].map(([id, key]) =>
            html`<button type="button" key=${id} class=${`btn sm${rt.strategy === id ? " primary" : ""}`} disabled=${busy} onClick=${() => setRoutingPolicy({ strategy: id }, t("steward.hub.policyUpdatedToast"))}>${t(key)}</button>`)}
          <button type="button" class="btn sm" disabled=${busy} onClick=${() => setRoutingPolicy({ mode: rt.mode === "shadow" ? "auto" : "shadow" }, t("steward.hub.policyUpdatedToast"))}>${rt.mode === "shadow" ? t("steward.hub.modeShadow") : t("steward.hub.modeAuto")}</button>
          <button type="button" class="btn sm" disabled=${busy} onClick=${() => runAction("/steward/routing/sync", { force: true }, t("steward.hub.poolSyncedToast"))}>${t("steward.hub.syncPoolBtn")}</button>
          ${rtDecs.length > 0 && html`<button type="button" class="btn sm" disabled=${busy} onClick=${() => runAction("/steward/routing/retry-stronger", {}, t("steward.hub.retryStrongerToast"))}>${t("steward.hub.retryStrongerBtn")}</button>`}
        </div>
        ${rtDecs.length === 0 && html`<div class="sg-card-hint">${t("steward.hub.routingEmpty")}</div>`}
        ${rtDecs.map((d) => html`<div key=${d.decisionId} class="sg-row">
          <div><strong>${d.rawModelId}</strong> <span class="badge">${d.archetype}</span><div class="sg-card-hint">${d.reasonSummary}</div></div>
          <span class="sg-card-hint">${d.escalatedFrom ? `↑ ${d.escalatedFrom}` : d.fallbackUsedFrom ? `↻ ${d.fallbackUsedFrom}` : `${Math.round((d.score || 0) * 100)}分`}</span>
        </div>`)}
        ${rtBoard.length > 0 && html`<div class="sg-card-hint">${t("steward.hub.leaderboardLabel")}${rtBoard.map(([arch, rows]) => `${arch}:${rows[0].targetId.split("/").pop()}(${Math.round(rows[0].posteriorQuality * 100)}%)`).join(" · ")}</div>`}
      </${HubCard}>`}
```
3) 在 `ui/components/provider-settings.js` 为每个服务商新增“同步模型”按钮与已同步模型数量角标：
```js
  const syncProviderModels = async (providerId) => {
    setBusyId(`sync-${providerId}`);
    try {
      const res = await api("/providers/sync-models", { method: "POST", body: { providerId, force: true } });
      const total = Array.isArray(res?.results) ? res.results.reduce((s, r) => s + (r.chatModelCount || 0), 0) : 0;
      toast(t("onboarding.panel.syncModelsDoneToast", { count: total }));
      await syncAfterChange();
    } catch (e) { failed(e); } finally { setBusyId(""); }
  };
```
```js
          ${Array.isArray(p.models) && p.models.length > 0 && html`<span class="badge">${t("onboarding.panel.modelCountBadge", { count: p.models.length })}</span>`}
          <button type="button" class="text accent" disabled=${!!busyId} onClick=${() => syncProviderModels(p.id)}>
            ${busyId === `sync-${p.id}` ? t("onboarding.panel.syncModelsRunning") : t("onboarding.panel.syncModelsBtn")}
          </button>
```

4) 双语文案对齐（所有新增 key 同步写入 `zh-CN` 与 `en`）：
- `ui/locales/zh-CN/steward.js`（`hub` 内追加）：
```js
    routingTitle: "智能路由与模型池",
    routingHint: "可用对话模型 {healthy}/{total} 个 · 冷却中 {cooling} 个",
    strategyQuota: "省配额",
    strategyBalanced: "平衡 (推荐)",
    strategyQuality: "质量优先",
    modeAuto: "全自动路由",
    modeShadow: "影子观察中",
    syncPoolBtn: "同步模型池",
    retryStrongerBtn: "换更强模型重试",
    routingEmpty: "发起对话后，此处将透明展示自动选模依据与经验分",
    policyUpdatedToast: "已更新自适应路由策略",
    poolSyncedToast: "已完成模型池全量同步",
    retryStrongerToast: "已记录纠偏反馈并切换更强模型重跑",
    leaderboardLabel: "近期经验榜首：",
```
- `ui/locales/en/steward.js`（`hub` 内追加同 key 英文）：
```js
    routingTitle: "Adaptive Routing & Model Pool",
    routingHint: "Healthy {healthy}/{total} chat models · {cooling} cooling",
    strategyQuota: "Quota Saver",
    strategyBalanced: "Balanced (Default)",
    strategyQuality: "Quality First",
    modeAuto: "Auto Routing",
    modeShadow: "Shadow Mode",
    syncPoolBtn: "Sync Pool",
    retryStrongerBtn: "Retry Stronger",
    routingEmpty: "Auto-routing rationales and learned experience scores appear here after a turn",
    policyUpdatedToast: "Updated adaptive routing policy",
    poolSyncedToast: "Synced model pool from upstream providers",
    retryStrongerToast: "Recorded correction feedback and retried with stronger model",
    leaderboardLabel: "Top learned by archetype: ",
```
- `ui/locales/zh-CN/onboarding.js` & `ui/locales/en/onboarding.js`（`panel` 内追加）：
  - zh-CN: `syncModelsBtn: "同步模型", syncModelsRunning: "同步中…", syncModelsDoneToast: "已对齐 {count} 个对话模型", modelCountBadge: "{count} 个模型"`
  - en: `syncModelsBtn: "Sync models", syncModelsRunning: "Syncing…", syncModelsDoneToast: "Aligned {count} chat models", modelCountBadge: "{count} models"`

- [ ] **Step 4: 运行 HTTP API 与既有路由/服务商回归测试**

Run: `npx vitest run test/sugent-steward-adaptive-routing.e2e.unit.test.ts test/sugent-steward-web-api.unit.test.ts test/sugent-providers-api.unit.test.ts < /dev/null`
Expected: PASS。

- [ ] **Step 5: 提交 Task 7**

```bash
git add src/web/server.ts ui/components/jarvis-workbench.js ui/components/provider-settings.js ui/locales/zh-CN/steward.js ui/locales/en/steward.js ui/locales/zh-CN/onboarding.js ui/locales/en/onboarding.js test/sugent-steward-adaptive-routing.e2e.unit.test.ts
git commit -m "feat(routing): expose adaptive routing HTTP APIs and zero-friction UI controls"
```

---

### Task 8: 注册测试脚本、`verify-sugent.mjs` 第 21 节契约校验与全量验收门禁

**Files:**
- Modify: `package.json:36`
- Modify: `scripts/verify-sugent.mjs:1-75,855-865`
- Test: `test/sugent-model-pool-sync.unit.test.ts`, `test/sugent-adaptive-router.unit.test.ts`, `test/sugent-steward-adaptive-routing.e2e.unit.test.ts`

**Interfaces:**
- Consumes: `ModelPoolSyncer`, `RoutingExperienceStore`, `AdaptiveModelRouter`, `ProviderRegistry`, `SugentModelCatalog`, `SugentStewardHostService`（经由 `dist/src/sugent/index.js` 导入）

- [ ] **Step 1: 在 `package.json` 第 36 行 `test:sugent` 列表末尾注册 3 个新测试文件**

追加：
`test/sugent-model-pool-sync.unit.test.ts test/sugent-adaptive-router.unit.test.ts test/sugent-steward-adaptive-routing.e2e.unit.test.ts`

- [ ] **Step 2: 在 `scripts/verify-sugent.mjs` 第 20 节后新增第 21 节自动化契约校验**

```js
// 21. CLIProxyAPI 全量模型对齐、熔断避让、经验后验反转与离线主权契约校验
{
  const rtDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-rt-verify-"));
  try {
    const reg = new ProviderRegistry(rtDir);
    reg.upsertProvider({ id: "cp", preset: "custom-openai", baseUrl: "http://127.0.0.1:8317/v1", apiKey: "sk-verify", enabled: true, setDefault: true, models: ["gpt-5-nano", "claude-sonnet-4-6", "gemini-4-hydrogen-xhigh", "text-embedding-3-small"] });
    const cat = new SugentModelCatalog(rtDir);
    const pool = new ModelPoolSyncer({ dataDir: rtDir, providers: reg, catalog: cat });
    assert.equal(pool.listChatCandidates().length, 3);

    const exp = new RoutingExperienceStore({ dataDir: rtDir });
    const router = new AdaptiveModelRouter({ pool, experience: exp, providers: reg, catalog: cat });
    const quick = router.planRoute({ role: "steward", text: "记个待办", hasTools: true });
    assert.equal(quick?.primary.rawModelId, "gpt-5-nano");

    pool.recordInfraFailure("cp/gpt-5-nano", 429);
    const quickAfter429 = router.planRoute({ role: "steward", text: "记个待办", hasTools: true });
    assert.notEqual(quickAfter429?.primary.rawModelId, "gpt-5-nano");
    assert.ok(quickAfter429?.skippedCoolingModels.includes("gpt-5-nano"));

    const nl = exp.applyNaturalLanguageDirective("以后写代码优先使用 claude-sonnet-4-6", pool.listChatCandidates().map((e) => e.targetId));
    assert.equal(nl.matched, true);
    const coding = router.planRoute({ role: "executor", text: "修复 TypeScript 编译错误", hasTools: true });
    assert.equal(coding?.primary.rawModelId, "claude-sonnet-4-6");
  } finally {
    fs.rmSync(rtDir, { recursive: true, force: true });
  }
}
```
并将底部日志文案追加 `/ M1–M3 全量模型同步与经验驱动自适应路由`。

- [ ] **Step 3: 顺序执行仓库强制验证门禁（全量绿灯后方可提交/宣布完成）**

Run 1: `npm run typecheck < /dev/null`
Run 2: `npm run test:sugent < /dev/null`
Run 3: `npm run verify:sugent < /dev/null`
Expected: 3 条命令全部退出码 0，0 类型错误、0 单测失败、1–21 节契约校验及 `docs:check` 全绿。

- [ ] **Step 4: 提交 Task 8**

```bash
git add package.json scripts/verify-sugent.mjs
git commit -m "test(routing): register adaptive routing suites and add verify:sugent section 21"
```

---

## Execution Pitfalls & Invariants（实现期避坑清单）

1. **`scripts/start-jarvis-workbench.mjs` 硬编码截断**：原先 `upsertDecoupledProvider` 传入了 `models: [m, "gemini-4-hydrogen-xhigh"]`，导致 `src/app.ts` 跳过 `/models` 自动发现；务必去掉固定列表并显式调用 `await app.syncProviderModels("custom-gateway", true)`。
2. **Gemini 4 `thought_signature` 回合粘性**：`StewardLlmAgent.runTurn` 进入多轮 `tool_calls` 后（Round 1–4）严禁更换模型，否则 `extra_content.google.thought_signature` 校验必崩；故障秒切与质量升档只允许在 Round 0 或显式重跑整轮时发生。
3. **`gemini-web2api` 36k 上下文安全墙兼容**：`BUILTIN_MODEL_RULES` 中既有的 `gemini-4-argon*` 与 `gemini-3.1-pro*` 规则被 `test/sugent-gemini-web2api-catalog.unit.test.ts` 与 `verify-sugent.mjs` 严格锁定为 `36_000` 上下文与 `0` 费率，新增 Gemini 3/4 API 规则绝不可覆盖或遮蔽它们。
4. **非对话模态模型过滤**：CLIProxyAPI `/v1/models` 常返回 `text-embedding-*`、`tts-*`、`whisper-*`、`veo-*`、`gemini-image`，必须通过 `isChatModel === true` 隔离在对话候选池之外。
5. **订阅配额稀缺度 vs 美元费率**：CLIProxyAPI 代理的 OAuth/订阅账号表观 USD 为 0，评分时必须叠加 `quotaScarcity` 与 429 频率，避免用限量 `xhigh` 模型处理“记个待办”这类轻请求。
6. **KnowledgeGraph 节点数测试不变量**：切勿在启动或同步模型池时向 `SugentKnowledgeGraph` 自动写节点（会破坏 `test/sugent-p2-web-api.unit.test.ts` 的 `nodeCount` 断言）；路由与经验数据独立存储在 `<dataDir>/sugent-routing/`。
7. **`htm` 模板插值语法**：`ui/components/jarvis-workbench.js` 使用 `htm` 标记模板，条件渲染与循环必须写 `${...}` 而非 JSX 的 `{...}`。
