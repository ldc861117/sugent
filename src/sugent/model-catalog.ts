import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface CatalogModelRates {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface CatalogModelInfo {
  context?: number;
  vision?: boolean;
  tools?: boolean;
  reasoning?: boolean;
  endpoints?: string[];
  rates?: CatalogModelRates;
}

export interface ModelOverridePatch {
  context?: number;
  vision?: boolean;
  tools?: boolean;
  reasoning?: boolean;
  endpoints?: string[];
  rates?: Partial<CatalogModelRates>;
}

interface BuiltinModelRule {
  match: (bareLowerModelId: string) => boolean;
  info: CatalogModelInfo;
}

const OVERRIDES_FILENAME = "sugent-model-overrides.json";

const BUILTIN_MODEL_RULES: readonly BuiltinModelRule[] = [
  // Anthropic Claude 4 / 3.7 / 3.5 — MUST include ["anthropic", "openai"] to activate native Messages API
  {
    match: (m) => m.startsWith("claude-opus-4-5") || m.startsWith("claude-opus-4-6"),
    info: {
      context: 200_000,
      vision: true,
      tools: true,
      reasoning: true,
      endpoints: ["anthropic", "openai"],
      rates: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    },
  },
  {
    match: (m) => m.startsWith("claude-opus-4"),
    info: {
      context: 200_000,
      vision: true,
      tools: true,
      reasoning: true,
      endpoints: ["anthropic", "openai"],
      rates: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    },
  },
  {
    match: (m) => m.startsWith("claude-sonnet-4"),
    info: {
      context: 200_000,
      vision: true,
      tools: true,
      reasoning: true,
      endpoints: ["anthropic", "openai"],
      rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    },
  },
  {
    match: (m) => m.startsWith("claude-haiku-4"),
    info: {
      context: 200_000,
      vision: true,
      tools: true,
      reasoning: true,
      endpoints: ["anthropic", "openai"],
      rates: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    },
  },
  {
    match: (m) => m.startsWith("claude-3-7"),
    info: {
      context: 200_000,
      vision: true,
      tools: true,
      reasoning: true,
      endpoints: ["anthropic", "openai"],
      rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    },
  },
  {
    match: (m) => m.startsWith("claude-3-5-haiku"),
    info: {
      context: 200_000,
      vision: true,
      tools: true,
      reasoning: false,
      endpoints: ["anthropic", "openai"],
      rates: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
    },
  },
  {
    match: (m) => m.startsWith("claude-3-5"),
    info: {
      context: 200_000,
      vision: true,
      tools: true,
      reasoning: false,
      endpoints: ["anthropic", "openai"],
      rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    },
  },
  {
    match: (m) => m.startsWith("claude-"),
    info: {
      context: 200_000,
      vision: true,
      tools: true,
      reasoning: false,
      endpoints: ["anthropic", "openai"],
      rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    },
  },

  // OpenAI GPT-5 / GPT-4.1 / GPT-4o / o3 / o4 — includes ["openai-response", "openai"]
  {
    match: (m) => m.startsWith("gpt-5-nano"),
    info: {
      context: 400_000,
      vision: true,
      tools: true,
      reasoning: true,
      endpoints: ["openai-response", "openai"],
      rates: { input: 0.05, output: 0.4, cacheRead: 0.005 },
    },
  },
  {
    match: (m) => m.startsWith("gpt-5-mini"),
    info: {
      context: 400_000,
      vision: true,
      tools: true,
      reasoning: true,
      endpoints: ["openai-response", "openai"],
      rates: { input: 0.25, output: 2, cacheRead: 0.025 },
    },
  },
  {
    match: (m) => m.startsWith("gpt-5"),
    info: {
      context: 400_000,
      vision: true,
      tools: true,
      reasoning: true,
      endpoints: ["openai-response", "openai"],
      rates: { input: 1.25, output: 10, cacheRead: 0.125 },
    },
  },
  {
    match: (m) => m.startsWith("gpt-4.1-nano"),
    info: {
      context: 1_047_576,
      vision: true,
      tools: true,
      reasoning: false,
      endpoints: ["openai-response", "openai"],
      rates: { input: 0.1, output: 0.4, cacheRead: 0.025 },
    },
  },
  {
    match: (m) => m.startsWith("gpt-4.1-mini"),
    info: {
      context: 1_047_576,
      vision: true,
      tools: true,
      reasoning: false,
      endpoints: ["openai-response", "openai"],
      rates: { input: 0.4, output: 1.6, cacheRead: 0.1 },
    },
  },
  {
    match: (m) => m.startsWith("gpt-4.1"),
    info: {
      context: 1_047_576,
      vision: true,
      tools: true,
      reasoning: false,
      endpoints: ["openai-response", "openai"],
      rates: { input: 2, output: 8, cacheRead: 0.5 },
    },
  },
  {
    match: (m) => m.startsWith("gpt-4o-mini"),
    info: {
      context: 128_000,
      vision: true,
      tools: true,
      reasoning: false,
      endpoints: ["openai-response", "openai"],
      rates: { input: 0.15, output: 0.6, cacheRead: 0.075 },
    },
  },
  {
    match: (m) => m.startsWith("gpt-4o"),
    info: {
      context: 128_000,
      vision: true,
      tools: true,
      reasoning: false,
      endpoints: ["openai-response", "openai"],
      rates: { input: 2.5, output: 10, cacheRead: 1.25 },
    },
  },
  {
    match: (m) => m.startsWith("o3-mini"),
    info: {
      context: 200_000,
      vision: false,
      tools: true,
      reasoning: true,
      endpoints: ["openai-response", "openai"],
      rates: { input: 1.1, output: 4.4, cacheRead: 0.55 },
    },
  },
  {
    match: (m) => m.startsWith("o3"),
    info: {
      context: 200_000,
      vision: true,
      tools: true,
      reasoning: true,
      endpoints: ["openai-response", "openai"],
      rates: { input: 2, output: 8, cacheRead: 0.5 },
    },
  },
  {
    match: (m) => m.startsWith("o4"),
    info: {
      context: 200_000,
      vision: true,
      tools: true,
      reasoning: true,
      endpoints: ["openai-response", "openai"],
      rates: { input: 1.1, output: 4.4, cacheRead: 0.275 },
    },
  },

  // DeepSeek
  {
    match: (m) => m === "deepseek-reasoner" || m.startsWith("deepseek-reasoner") || m.startsWith("deepseek-r1"),
    info: {
      context: 128_000,
      vision: false,
      tools: true,
      reasoning: true,
      endpoints: ["openai"],
      rates: { input: 0.55, output: 2.19, cacheRead: 0.14 },
    },
  },
  {
    match: (m) => m === "deepseek-chat" || m.startsWith("deepseek-chat") || m.startsWith("deepseek-v3"),
    info: {
      context: 128_000,
      vision: false,
      tools: true,
      reasoning: false,
      endpoints: ["openai"],
      rates: { input: 0.27, output: 1.1, cacheRead: 0.07 },
    },
  },

  // zexadev/gemini-web2api-go: 4 Argon medium (server-side thinking without reasoning_content)
  {
    match: (m) => m === "gemini-4-argon-thinking-medium",
    info: {
      context: 36_000,
      vision: true,
      tools: true,
      reasoning: false,
      endpoints: ["openai-response", "openai"],
      rates: { input: 0, output: 0 },
    },
  },
  // zexadev/gemini-web2api-go: 3.1 Pro family & all *-thinking variants (cookie-gated)
  {
    match: (m) =>
      m.startsWith("gemini-3.1-pro") ||
      (m.endsWith("-thinking") &&
        (m.startsWith("gemini-4-argon") ||
          m.startsWith("gemini-3.8-flash") ||
          m.startsWith("gemini-3.7-flash") ||
          m.startsWith("gemini-3.6-flash") ||
          m.startsWith("gemini-3.5-flash-lite"))),
    info: {
      context: 36_000,
      vision: true,
      tools: true,
      reasoning: true,
      endpoints: ["openai-response", "openai"],
      rates: { input: 0, output: 0 },
    },
  },
  // zexadev/gemini-web2api-go: Paid cookie base models (4 Argon / 3.8 Flash / 3.7 alias)
  {
    match: (m) =>
      m.startsWith("gemini-4-argon") ||
      m.startsWith("gemini-3.8-flash") ||
      m.startsWith("gemini-3.7-flash"),
    info: {
      context: 36_000,
      vision: true,
      tools: true,
      reasoning: false,
      endpoints: ["openai-response", "openai"],
      rates: { input: 0, output: 0 },
    },
  },
  // zexadev/gemini-web2api-go: Anonymous base text models (3.6 Flash / 3.5 Flash-Lite) & Canvas
  {
    match: (m) =>
      m.startsWith("gemini-3.6-flash") ||
      m.startsWith("gemini-3.5-flash-lite") ||
      m === "gemini-canvas",
    info: {
      context: 36_000,
      vision: false,
      tools: true,
      reasoning: false,
      endpoints: ["openai-response", "openai"],
      rates: { input: 0, output: 0 },
    },
  },
  // zexadev/gemini-web2api-go: Media generators (Nano Banana / Lyria / Video)
  {
    match: (m) =>
      m === "gemini-image" || m === "gemini-music" || m === "gemini-video",
    info: {
      context: 36_000,
      vision: false,
      tools: false,
      reasoning: false,
      endpoints: ["openai-response", "openai"],
      rates: { input: 0, output: 0 },
    },
  },

  // Non-chat modalities exclusion (prevents Steward chat pool from selecting media/embedding models)
  {
    match: (m) =>
      /(^|[-_/])(embedding|embed|tts|whisper|dall-e|imagen|veo|lyria|sora|moderation|rerank)/.test(m) ||
      /(image-gen|gpt-image|-image-preview|-image$)/.test(m),
    info: {
      context: 8_192,
      vision: false,
      tools: false,
      reasoning: false,
      endpoints: ["openai"],
    },
  },

  // Google Gemini 4 / 3 Official & CLIProxyAPI Chat Models (never shadows gemini-4-argon* / gemini-3.1-pro*)
  {
    match: (m) => m.startsWith("gemini-4-flash") || m.startsWith("gemini-3-flash"),
    info: {
      context: 1_048_576,
      vision: true,
      tools: true,
      reasoning: true,
      endpoints: ["openai"],
      rates: { input: 0.3, output: 2.5, cacheRead: 0.075 },
    },
  },
  {
    match: (m) =>
      m.startsWith("gemini-4-hydrogen") ||
      m.startsWith("gemini-4-neon") ||
      m.startsWith("gemini-4-pro") ||
      m.startsWith("gemini-3-pro"),
    info: {
      context: 1_048_576,
      vision: true,
      tools: true,
      reasoning: true,
      endpoints: ["openai"],
      rates: { input: 1.25, output: 10, cacheRead: 0.31 },
    },
  },

  // Google Gemini 2.5
  {
    match: (m) => m.startsWith("gemini-2.5-flash"),
    info: {
      context: 1_048_576,
      vision: true,
      tools: true,
      reasoning: true,
      endpoints: ["openai"],
      rates: { input: 0.3, output: 2.5, cacheRead: 0.075 },
    },
  },
  {
    match: (m) => m.startsWith("gemini-2.5"),
    info: {
      context: 1_048_576,
      vision: true,
      tools: true,
      reasoning: true,
      endpoints: ["openai"],
      rates: { input: 1.25, output: 10, cacheRead: 0.31 },
    },
  },

  // Qwen
  {
    match: (m) => m.startsWith("qwen") && m.includes("vl"),
    info: {
      context: 128_000,
      vision: true,
      tools: true,
      reasoning: false,
      endpoints: ["openai"],
      rates: { input: 0.4, output: 1.2 },
    },
  },
  {
    match: (m) => m.startsWith("qwen3") || m.startsWith("qwq"),
    info: {
      context: 128_000,
      vision: false,
      tools: true,
      reasoning: true,
      endpoints: ["openai"],
      rates: { input: 0.4, output: 1.2 },
    },
  },
  {
    match: (m) => m.startsWith("qwen"),
    info: {
      context: 128_000,
      vision: false,
      tools: true,
      reasoning: false,
      endpoints: ["openai"],
      rates: { input: 0.4, output: 1.2 },
    },
  },

  // Meta Llama
  {
    match: (m) => m.startsWith("llama") && (m.includes("vision") || m.startsWith("llama-4")),
    info: {
      context: 128_000,
      vision: true,
      tools: true,
      reasoning: false,
      endpoints: ["openai"],
      rates: { input: 0.2, output: 0.6 },
    },
  },
  {
    match: (m) => m.startsWith("llama"),
    info: {
      context: 128_000,
      vision: false,
      tools: true,
      reasoning: false,
      endpoints: ["openai"],
      rates: { input: 0.2, output: 0.6 },
    },
  },
];

const DEFAULT_FALLBACK_INFO: CatalogModelInfo = {
  context: 128_000,
  vision: false,
  tools: true,
  reasoning: false,
  endpoints: ["openai"],
};

function cloneModelInfo(info: CatalogModelInfo): CatalogModelInfo {
  const result: CatalogModelInfo = {};
  if (info.context !== undefined) {
    result.context = info.context;
  }
  if (info.vision !== undefined) {
    result.vision = info.vision;
  }
  if (info.tools !== undefined) {
    result.tools = info.tools;
  }
  if (info.reasoning !== undefined) {
    result.reasoning = info.reasoning;
  }
  if (info.endpoints !== undefined) {
    result.endpoints = [...info.endpoints];
  }
  if (info.rates !== undefined) {
    const rates: CatalogModelRates = {
      input: info.rates.input,
      output: info.rates.output,
    };
    if (info.rates.cacheRead !== undefined) {
      rates.cacheRead = info.rates.cacheRead;
    }
    if (info.rates.cacheWrite !== undefined) {
      rates.cacheWrite = info.rates.cacheWrite;
    }
    result.rates = rates;
  }
  return result;
}

export function stripProviderPrefix(modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed.includes("/")) {
    return trimmed;
  }
  const segments = trimmed.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? trimmed;
}

function isOllamaModelSpec(rawModelId: string): boolean {
  const normalized = rawModelId.trim().toLowerCase();
  return (
    normalized.startsWith("ollama/") ||
    normalized.includes("/ollama/")
  );
}

export function resolveBuiltinModelInfo(modelId: string): CatalogModelInfo {
  const trimmed = modelId.trim();
  const bareLower = stripProviderPrefix(trimmed).toLowerCase();
  const isOllama = isOllamaModelSpec(trimmed);

  let matched: CatalogModelInfo | undefined;
  for (const rule of BUILTIN_MODEL_RULES) {
    if (rule.match(bareLower)) {
      matched = cloneModelInfo(rule.info);
      break;
    }
  }

  const resolved = matched ?? cloneModelInfo(DEFAULT_FALLBACK_INFO);

  if (isOllama) {
    resolved.endpoints = ["openai"];
    resolved.rates = { input: 0, output: 0 };
  }

  return resolved;
}

function matchesWildcardPattern(pattern: string, target: string): boolean {
  const p = pattern.trim().toLowerCase();
  const t = target.trim().toLowerCase();
  if (!p) {
    return false;
  }
  if (p === t) {
    return true;
  }
  if (p.endsWith("*")) {
    return t.startsWith(p.slice(0, -1));
  }
  return false;
}

function applyOverridePatch(base: CatalogModelInfo, patch: ModelOverridePatch): CatalogModelInfo {
  const next = cloneModelInfo(base);
  if (typeof patch.context === "number" && Number.isFinite(patch.context) && patch.context > 0) {
    next.context = patch.context;
  }
  if (typeof patch.vision === "boolean") {
    next.vision = patch.vision;
  }
  if (typeof patch.tools === "boolean") {
    next.tools = patch.tools;
  }
  if (typeof patch.reasoning === "boolean") {
    next.reasoning = patch.reasoning;
  }
  if (Array.isArray(patch.endpoints) && patch.endpoints.length > 0) {
    next.endpoints = [...patch.endpoints];
  }
  if (patch.rates && typeof patch.rates === "object") {
    const baseInput = next.rates?.input ?? 0;
    const baseOutput = next.rates?.output ?? 0;
    const mergedRates: CatalogModelRates = {
      input:
        typeof patch.rates.input === "number" && Number.isFinite(patch.rates.input)
          ? patch.rates.input
          : baseInput,
      output:
        typeof patch.rates.output === "number" && Number.isFinite(patch.rates.output)
          ? patch.rates.output
          : baseOutput,
    };
    const cacheRead =
      typeof patch.rates.cacheRead === "number" && Number.isFinite(patch.rates.cacheRead)
        ? patch.rates.cacheRead
        : next.rates?.cacheRead;
    if (cacheRead !== undefined) {
      mergedRates.cacheRead = cacheRead;
    }
    const cacheWrite =
      typeof patch.rates.cacheWrite === "number" && Number.isFinite(patch.rates.cacheWrite)
        ? patch.rates.cacheWrite
        : next.rates?.cacheWrite;
    if (cacheWrite !== undefined) {
      mergedRates.cacheWrite = cacheWrite;
    }
    next.rates = mergedRates;
  }
  return next;
}

function writeAtomicJson600(targetPath: string, data: unknown): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const suffix = `${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}`;
  const tmpPath = path.join(dir, `.${path.basename(targetPath)}.${suffix}.tmp`);
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Ignore cleanup errors.
    }
    throw err;
  }
}

export class SugentModelCatalog {
  private readonly filePath: string | null;
  private overrides = new Map<string, ModelOverridePatch>();

  constructor(dataDirOrOptions?: string | { dataDir?: string }) {
    const dataDir =
      typeof dataDirOrOptions === "string"
        ? dataDirOrOptions
        : dataDirOrOptions?.dataDir;
    this.filePath = dataDir ? path.join(dataDir, OVERRIDES_FILENAME) : null;
    this.reload();
  }

  reload(): void {
    this.overrides.clear();
    if (!this.filePath || !fs.existsSync(this.filePath)) {
      return;
    }

    const raw = fs.readFileSync(this.filePath, "utf8").trim();
    if (!raw) {
      return;
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const table =
      parsed &&
      typeof parsed === "object" &&
      parsed.models &&
      typeof parsed.models === "object" &&
      !Array.isArray(parsed.models)
        ? (parsed.models as Record<string, unknown>)
        : parsed;

    for (const [key, value] of Object.entries(table)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const normalizedKey = stripProviderPrefix(key).toLowerCase();
        this.overrides.set(normalizedKey, value as ModelOverridePatch);
      }
    }
  }

  getModelInfo(modelId: string): CatalogModelInfo {
    const base = resolveBuiltinModelInfo(modelId);
    const bareKey = stripProviderPrefix(modelId).toLowerCase();

    const exactPatch = this.overrides.get(bareKey);
    if (exactPatch) {
      return applyOverridePatch(base, exactPatch);
    }

    for (const [pattern, patch] of this.overrides.entries()) {
      if (pattern.endsWith("*") && matchesWildcardPattern(pattern, bareKey)) {
        return applyOverridePatch(base, patch);
      }
    }

    return base;
  }

  resolveModelInfo(modelId: string): CatalogModelInfo {
    return this.getModelInfo(modelId);
  }

  setModelOverride(modelId: string, patch: ModelOverridePatch): CatalogModelInfo {
    const bareKey = stripProviderPrefix(modelId).toLowerCase();
    if (!bareKey) {
      throw new Error("Model id cannot be empty");
    }
    this.overrides.set(bareKey, patch);
    this.saveToDisk();
    return this.getModelInfo(bareKey);
  }

  removeModelOverride(modelId: string): boolean {
    const bareKey = stripProviderPrefix(modelId).toLowerCase();
    const deleted = this.overrides.delete(bareKey);
    if (deleted) {
      this.saveToDisk();
    }
    return deleted;
  }

  estimateCostUsd(
    modelId: string,
    usage: {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    },
  ): number {
    const rates = this.getModelInfo(modelId).rates;
    if (!rates) {
      return 0;
    }
    const input = Math.max(0, usage.inputTokens ?? 0) * rates.input;
    const output = Math.max(0, usage.outputTokens ?? 0) * rates.output;
    const cacheRead =
      Math.max(0, usage.cacheReadTokens ?? 0) * (rates.cacheRead ?? 0);
    const cacheWrite =
      Math.max(0, usage.cacheWriteTokens ?? 0) * (rates.cacheWrite ?? 0);
    return (input + output + cacheRead + cacheWrite) / 1_000_000;
  }

  private saveToDisk(): void {
    if (!this.filePath) {
      return;
    }
    const serialized: Record<string, ModelOverridePatch> = {};
    for (const [key, patch] of this.overrides.entries()) {
      serialized[key] = patch;
    }
    writeAtomicJson600(this.filePath, serialized);
  }
}


export type ModelTier = "fast" | "balanced" | "frontier" | "reasoning";
export type ModelFamily =
  | "claude"
  | "openai"
  | "gemini"
  | "deepseek"
  | "qwen"
  | "llama"
  | "other";
export type ModelModality = "chat" | "image_gen" | "audio" | "video" | "embedding";

export interface ModelCapabilityProfile {
  rawModelId: string;
  bareModelId: string;
  family: ModelFamily;
  tier: ModelTier;
  modalities: ModelModality[];
  isChatModel: boolean;
  context: number;
  vision: boolean;
  tools: boolean;
  reasoning: boolean;
  thoughtSignatureRequired: boolean;
  priorQuality: number;
  quotaScarcity: number;
  rates?: CatalogModelRates;
  inferredFromFallback: boolean;
}

export function hasBuiltinModelRule(modelId: string): boolean {
  const bareLower = stripProviderPrefix(modelId).toLowerCase();
  return BUILTIN_MODEL_RULES.some((rule) => rule.match(bareLower));
}

export function parseModelSpecMetadata(rawModelId: string): {
  bareModelId: string;
  normalized: string;
  hasThinkingTag: boolean;
  hasXHighTag: boolean;
  family: ModelFamily;
} {
  const bareModelId = stripProviderPrefix(rawModelId);
  const normalized = bareModelId.toLowerCase();
  const family: ModelFamily = normalized.includes("claude")
    ? "claude"
    : normalized.startsWith("gpt-") ||
        normalized.startsWith("chatgpt-") ||
        /^o[134](-|$)/.test(normalized) ||
        normalized.includes("codex")
      ? "openai"
      : normalized.includes("gemini")
        ? "gemini"
        : normalized.includes("deepseek")
          ? "deepseek"
          : normalized.startsWith("qwen") || normalized.startsWith("qwq")
            ? "qwen"
            : normalized.includes("llama")
              ? "llama"
              : "other";
  return {
    bareModelId,
    normalized,
    hasThinkingTag: normalized.includes("thinking"),
    hasXHighTag: normalized.includes("xhigh"),
    family,
  };
}

export function classifyModelProfile(
  modelId: string,
  catalog?: SugentModelCatalog,
): ModelCapabilityProfile {
  const meta = parseModelSpecMetadata(modelId);
  const info = catalog
    ? catalog.getModelInfo(modelId)
    : resolveBuiltinModelInfo(modelId);
  const m = meta.normalized;
  const modalities: ModelModality[] = [];
  if (/(embedding|embed|rerank)/.test(m)) {
    modalities.push("embedding");
  } else if (
    /(dall-e|imagen|gemini-image|image-gen|gpt-image|-image-preview|-image$)/.test(m)
  ) {
    modalities.push("image_gen");
  } else if (/(tts|whisper|lyria|gemini-music|audio)/.test(m)) {
    modalities.push("audio");
  } else if (/(veo|sora|gemini-video)/.test(m)) {
    modalities.push("video");
  } else if (!/(^|[-_/])moderation/.test(m)) {
    modalities.push("chat");
  }
  const isChatModel = modalities.includes("chat");
  const isSmall = /(nano|lite|8b|7b|mini|flash|haiku|3\.5-turbo)/.test(m);
  const tier: ModelTier = !isChatModel
    ? "fast"
    : meta.hasXHighTag ||
        meta.hasThinkingTag ||
        /^(o[134](-|$)|deepseek-r1|deepseek-reasoner|qwq)/.test(m) ||
        m.includes("hydrogen") ||
        m.includes("neon")
      ? "reasoning"
      : /(opus|sonnet-4|gpt-5|gpt-4\.1|gpt-4o|gemini-4-pro|gemini-3-pro|gemini-2\.5-pro|codex)/.test(m) &&
          !isSmall
        ? "frontier"
        : /(nano|lite|8b|7b)/.test(m)
          ? "fast"
          : /(mini|flash|haiku|deepseek-chat|deepseek-v3|gpt-4o-mini|gpt-4\.1-mini|gpt-5-mini)/.test(m)
            ? "balanced"
            : "balanced";
  const [priorQuality, quotaScarcity] = !isChatModel
    ? [0, 0]
    : tier === "reasoning"
      ? [0.92, 0.95]
      : tier === "frontier"
        ? [0.88, 0.8]
        : tier === "balanced"
          ? [0.78, 0.42]
          : [0.65, 0.15];
  const builtinMatch = hasBuiltinModelRule(modelId);
  return {
    rawModelId: modelId.trim(),
    bareModelId: meta.bareModelId,
    family: meta.family,
    tier,
    modalities,
    isChatModel,
    context: info.context ?? 128_000,
    vision: Boolean(info.vision),
    tools: Boolean(info.tools),
    reasoning: Boolean(info.reasoning),
    thoughtSignatureRequired:
      meta.family === "gemini" &&
      (m.includes("gemini-3") || m.includes("gemini-4")) &&
      isChatModel,
    priorQuality: builtinMatch ? priorQuality : Math.min(priorQuality, 0.72),
    quotaScarcity,
    ...(info.rates ? { rates: info.rates } : {}),
    inferredFromFallback: !builtinMatch,
  };
}
