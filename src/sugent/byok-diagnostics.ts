import { performance } from "node:perf_hooks";
import type { CatalogModelInfo } from "./model-catalog.js";
import type { BotBudgetStatus } from "./local-budget.js";

export type SugentProviderId =
  | "openai"
  | "anthropic"
  | "deepseek"
  | "gemini"
  | "openrouter"
  | "ollama"
  | "cowork"
  | "custom-openai"
  | "gemini-web2api";

export type SugentAgentRole = "assessor" | "executor" | "computerUse" | "steward";

export type ByokDiagnosticCode =
  | "OK"
  | "MISSING_API_KEY"
  | "AUTH_INVALID_KEY"
  | "QUOTA_EXCEEDED"
  | "RATE_LIMITED"
  | "MODEL_NOT_FOUND"
  | "TLS_HANDSHAKE_FAILED"
  | "ENDPOINT_UNREACHABLE"
  | "TIMEOUT"
  | "UPSTREAM_SERVER_ERROR";

export interface ByokProbeTarget {
  providerId: SugentProviderId;
  role: SugentAgentRole;
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  probeCapabilities?: boolean;
}

export interface ByokCapabilityMatrix {
  chatCompletions: boolean;
  toolCalling: boolean;
  responsesApi: boolean;
}

export interface ByokProbeResult {
  providerId: SugentProviderId;
  role: SugentAgentRole;
  modelId: string;
  endpointTested: string;
  status: "healthy" | "degraded" | "unhealthy";
  diagnosticCode: ByokDiagnosticCode;
  httpStatus: number | null;
  ttftMs: number | null;
  totalLatencyMs: number;
  capabilities: ByokCapabilityMatrix;
  remediationHint: string;
}

export interface ByokDiagnosticsReport {
  checkedAtIso: string;
  results: ByokProbeResult[];
  summary: {
    total: number;
    healthyCount: number;
    degradedCount: number;
    unhealthyCount: number;
    fastestExecutorMs: number | null;
  };
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface ByokDiagnosticsOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  concurrency?: number;
}

export interface ModelPricingSpec {
  inputCostPer1M: number;
  outputCostPer1M: number;
  cachedInputCostPer1M?: number;
  contextWindow?: number;
}

export interface CatalogPricingReader {
  getModelPricing?(modelId: string): ModelPricingSpec | null;
  getModelInfo?(modelId: string): CatalogModelInfo;
}

export interface RoleDailyWorkload {
  dailyTasks: number;
  avgInputTokensPerTask: number;
  avgOutputTokensPerTask: number;
}

export type WorkloadPresetId = "solo-light" | "opc-standard" | "heavy-autopilot";

export interface BudgetLedgerSnapshot {
  monthlyCapUsd: number | null;
  currentMonthSpentUsd: number;
  observedDailyWorkload?: Partial<Record<SugentAgentRole, RoleDailyWorkload>>;
}

export type LedgerInput = BudgetLedgerSnapshot | BotBudgetStatus;

export interface CostSandboxInput {
  roleModels: Record<SugentAgentRole, string>;
  preset?: WorkloadPresetId;
  customWorkload?: Partial<Record<SugentAgentRole, RoleDailyWorkload>>;
  activeDaysPerMonth?: number;
  promptCacheHitRatio?: number;
  catalog: CatalogPricingReader;
  ledger?: LedgerInput;
}

export interface RoleCostBreakdown {
  role: SugentAgentRole;
  modelId: string;
  monthlyInputTokens: number;
  monthlyOutputTokens: number;
  monthlyUsd: number;
}

export interface CostSandboxSimulation {
  activeDaysPerMonth: number;
  promptCacheHitRatio: number;
  roleBreakdown: Record<SugentAgentRole, RoleCostBreakdown>;
  monthlyTotalUsd: number;
  allFlagshipBaselineUsd: number;
  monthlySavingsUsd: number;
  savingsRatio: number;
  budgetHealth: {
    monthlyCapUsd: number | null;
    currentMonthSpentUsd: number;
    projectedExceedsCap: boolean;
    remainingRunwayUsd: number | null;
  };
}

const KEYLESS_ALLOWED_PROVIDERS = new Set<SugentProviderId>([
  "ollama",
  "custom-openai",
  "gemini-web2api",
]);

export const WORKLOAD_PRESETS: Record<
  WorkloadPresetId,
  Record<SugentAgentRole, RoleDailyWorkload>
> = {
  "solo-light": {
    assessor: { dailyTasks: 60, avgInputTokensPerTask: 1500, avgOutputTokensPerTask: 250 },
    executor: { dailyTasks: 12, avgInputTokensPerTask: 12000, avgOutputTokensPerTask: 2200 },
    computerUse: { dailyTasks: 6, avgInputTokensPerTask: 8000, avgOutputTokensPerTask: 800 },
    steward: { dailyTasks: 48, avgInputTokensPerTask: 2000, avgOutputTokensPerTask: 300 },
  },
  "opc-standard": {
    assessor: { dailyTasks: 180, avgInputTokensPerTask: 2000, avgOutputTokensPerTask: 300 },
    executor: { dailyTasks: 35, avgInputTokensPerTask: 18000, avgOutputTokensPerTask: 3200 },
    computerUse: { dailyTasks: 20, avgInputTokensPerTask: 10000, avgOutputTokensPerTask: 1000 },
    steward: { dailyTasks: 120, avgInputTokensPerTask: 2500, avgOutputTokensPerTask: 400 },
  },
  "heavy-autopilot": {
    assessor: { dailyTasks: 500, avgInputTokensPerTask: 2400, avgOutputTokensPerTask: 350 },
    executor: { dailyTasks: 90, avgInputTokensPerTask: 24000, avgOutputTokensPerTask: 4500 },
    computerUse: { dailyTasks: 60, avgInputTokensPerTask: 14000, avgOutputTokensPerTask: 1200 },
    steward: { dailyTasks: 360, avgInputTokensPerTask: 3000, avgOutputTokensPerTask: 500 },
  },
};

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, "");
}

function buildAuthHeaders(providerId: SugentProviderId, apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (!apiKey) {
    return headers;
  }
  if (providerId === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    return headers;
  }
  if (providerId === "gemini") {
    headers["x-goog-api-key"] = apiKey;
    return headers;
  }
  headers["Authorization"] = `Bearer ${apiKey}`;
  return headers;
}

function classifyHttpFailure(status: number, bodyText: string): {
  code: ByokDiagnosticCode;
  hint: string;
} {
  const lower = bodyText.toLowerCase();
  if (status === 401 || status === 403) {
    return {
      code: "AUTH_INVALID_KEY",
      hint: "API Key 鉴权被拒绝，请核查密钥拼写、组织权限或是否已吊销。",
    };
  }
  if (
    status === 402 ||
    (status === 429 && (lower.includes("insufficient_quota") || lower.includes("balance")))
  ) {
    return {
      code: "QUOTA_EXCEEDED",
      hint: "供应商账户余额或月度配额已耗尽，请充值或切换备用供应商。",
    };
  }
  if (status === 429) {
    return {
      code: "RATE_LIMITED",
      hint: "触发供应商 RPM/TPM 速率限制，建议降低并发或为守门员分配独立渠道。",
    };
  }
  if (status === 404) {
    return {
      code: "MODEL_NOT_FOUND",
      hint: "目标模型 ID 或 API 路径不存在，请检查 baseUrl 是否遗漏 /v1 或模型是否已下线。",
    };
  }
  return {
    code: "UPSTREAM_SERVER_ERROR",
    hint: `上游网关返回 HTTP ${status}，请稍后重试或检查反代网关状态。`,
  };
}

function classifyNetworkError(err: unknown): {
  code: ByokDiagnosticCode;
  hint: string;
} {
  const name = err instanceof Error ? err.name : "";
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (name === "TimeoutError" || name === "AbortError" || msg.includes("timeout")) {
    return {
      code: "TIMEOUT",
      hint: "连接或首字节响应超时，请检查本地代理规则、防火墙或更换低延迟接入点。",
    };
  }
  if (msg.includes("cert") || msg.includes("tls") || msg.includes("ssl")) {
    return {
      code: "TLS_HANDSHAKE_FAILED",
      hint: "TLS 证书校验失败，请检查自定义网关 HTTPS 证书链或企业抓包根证书配置。",
    };
  }
  return {
    code: "ENDPOINT_UNREACHABLE",
    hint: "无法建立 TCP/DNS 连接，请确认本地服务端口已启动且域名可解析。",
  };
}

async function probeSingleTarget(
  target: ByokProbeTarget,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<ByokProbeResult> {
  const base = normalizeBaseUrl(target.baseUrl);
  const startedAt = performance.now();

  if (!target.apiKey && !KEYLESS_ALLOWED_PROVIDERS.has(target.providerId)) {
    return {
      providerId: target.providerId,
      role: target.role,
      modelId: target.modelId,
      endpointTested: base,
      status: "unhealthy",
      diagnosticCode: "MISSING_API_KEY",
      httpStatus: null,
      ttftMs: null,
      totalLatencyMs: 0,
      capabilities: { chatCompletions: false, toolCalling: false, responsesApi: false },
      remediationHint: "尚未配置该云端供应商的 API Key。",
    };
  }

  const headers = buildAuthHeaders(target.providerId, target.apiKey);
  const capabilities: ByokCapabilityMatrix = {
    chatCompletions: false,
    toolCalling: false,
    responsesApi: false,
  };

  let primaryEndpoint = `${base}/models`;
  let primaryInit: RequestInit = {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  };

  if (target.providerId === "ollama") {
    primaryEndpoint = `${base.replace(/\/v1$/, "")}/api/tags`;
  } else if (target.providerId === "anthropic") {
    primaryEndpoint = `${base}/messages`;
    primaryInit = {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: target.modelId,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    };
  } else if (target.providerId === "gemini") {
    primaryEndpoint = `${base}/models/${encodeURIComponent(target.modelId)}`;
  } else if (
    target.probeCapabilities &&
    (target.providerId === "openai" ||
      target.providerId === "cowork" ||
      target.providerId === "gemini-web2api")
  ) {
    primaryEndpoint = `${base}/responses`;
    primaryInit = {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: target.modelId,
        max_output_tokens: 16,
        input: "Invoke ping_probe if available.",
        tools: [
          {
            type: "function",
            name: "ping_probe",
            description: "Connectivity health probe",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    };
  }

  try {
    const res = await fetchImpl(primaryEndpoint, primaryInit);
    const ttftMs = Math.round((performance.now() - startedAt) * 100) / 100;
    const bodyText = await res.text();
    const totalLatencyMs = Math.round((performance.now() - startedAt) * 100) / 100;

    if (!res.ok) {
      const failure = classifyHttpFailure(res.status, bodyText);
      return {
        providerId: target.providerId,
        role: target.role,
        modelId: target.modelId,
        endpointTested: primaryEndpoint,
        status: "unhealthy",
        diagnosticCode: failure.code,
        httpStatus: res.status,
        ttftMs,
        totalLatencyMs,
        capabilities,
        remediationHint: failure.hint,
      };
    }

    capabilities.chatCompletions = true;
    if (primaryEndpoint.endsWith("/responses")) {
      capabilities.responsesApi = true;
      if (bodyText.includes("function_call") || bodyText.includes("ping_probe")) {
        capabilities.toolCalling = true;
      }
    } else if (target.probeCapabilities) {
      const toolEndpoint =
        target.providerId === "ollama"
          ? `${base.replace(/\/v1$/, "")}/v1/chat/completions`
          : `${base}/chat/completions`;
      try {
        const toolRes = await fetchImpl(toolEndpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: target.modelId,
            max_tokens: 16,
            messages: [{ role: "user", content: "Call ping_probe." }],
            tools: [
              {
                type: "function",
                function: {
                  name: "ping_probe",
                  parameters: { type: "object", properties: {} },
                },
              },
            ],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (toolRes.ok) {
          const toolJson = await toolRes.text();
          capabilities.toolCalling =
            toolJson.includes("tool_calls") || toolJson.includes("ping_probe");
        }
      } catch {
        // Optional tool probe failure keeps base connectivity green.
      }
    }

    return {
      providerId: target.providerId,
      role: target.role,
      modelId: target.modelId,
      endpointTested: primaryEndpoint,
      status: ttftMs > 2500 ? "degraded" : "healthy",
      diagnosticCode: "OK",
      httpStatus: res.status,
      ttftMs,
      totalLatencyMs,
      capabilities,
      remediationHint:
        ttftMs > 2500
          ? "连通正常但首字节延迟偏高（超过 2.5s），建议将该节点调整为非实时后台角色。"
          : "连通性与鉴权状态正常。",
    };
  } catch (err) {
    const totalLatencyMs = Math.round((performance.now() - startedAt) * 100) / 100;
    const failure = classifyNetworkError(err);
    return {
      providerId: target.providerId,
      role: target.role,
      modelId: target.modelId,
      endpointTested: primaryEndpoint,
      status: "unhealthy",
      diagnosticCode: failure.code,
      httpStatus: null,
      ttftMs: null,
      totalLatencyMs,
      capabilities,
      remediationHint: failure.hint,
    };
  }
}

export async function runByokDiagnostics(
  targets: readonly ByokProbeTarget[],
  options: ByokDiagnosticsOptions = {},
): Promise<ByokDiagnosticsReport> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 6000;
  const concurrency = Math.max(1, options.concurrency ?? 4);

  const results: ByokProbeResult[] = new Array(targets.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < targets.length) {
      const index = cursor++;
      const target = targets[index];
      if (target) {
        results[index] = await probeSingleTarget(target, fetchImpl, timeoutMs);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, targets.length)) }, () => worker()),
  );

  const healthyCount = results.filter((r) => r.status === "healthy").length;
  const degradedCount = results.filter((r) => r.status === "degraded").length;
  const unhealthyCount = results.filter((r) => r.status === "unhealthy").length;
  const executorLatencies = results
    .filter((r) => r.role === "executor" && r.ttftMs !== null)
    .map((r) => r.ttftMs as number);

  return {
    checkedAtIso: new Date().toISOString(),
    results,
    summary: {
      total: results.length,
      healthyCount,
      degradedCount,
      unhealthyCount,
      fastestExecutorMs: executorLatencies.length > 0 ? Math.min(...executorLatencies) : null,
    },
  };
}

function readPricingFromCatalog(
  catalog: CatalogPricingReader,
  modelId: string,
): ModelPricingSpec | null {
  if (typeof catalog.getModelPricing === "function") {
    return catalog.getModelPricing(modelId);
  }
  if (typeof catalog.getModelInfo === "function") {
    const info = catalog.getModelInfo(modelId);
    if (!info.rates) {
      return null;
    }
    return {
      inputCostPer1M: info.rates.input,
      outputCostPer1M: info.rates.output,
      ...(info.rates.cacheRead !== undefined
        ? { cachedInputCostPer1M: info.rates.cacheRead }
        : {}),
      ...(info.context !== undefined ? { contextWindow: info.context } : {}),
    };
  }
  return null;
}

function normalizeLedgerSnapshot(ledger?: LedgerInput): BudgetLedgerSnapshot | undefined {
  if (!ledger) {
    return undefined;
  }
  if ("limitUsd" in ledger && "usedUsd" in ledger) {
    return {
      monthlyCapUsd: ledger.enabled ? ledger.limitUsd : null,
      currentMonthSpentUsd: ledger.usedUsd,
    };
  }
  return ledger;
}

function computeTokenCostUsd(
  pricing: ModelPricingSpec,
  inputTokens: number,
  outputTokens: number,
  cacheRatio: number,
): number {
  const clampedCache = Math.min(1, Math.max(0, cacheRatio));
  const cachedRate = pricing.cachedInputCostPer1M ?? pricing.inputCostPer1M;
  const uncachedInput = inputTokens * (1 - clampedCache);
  const cachedInput = inputTokens * clampedCache;

  const inputUsd =
    (uncachedInput / 1_000_000) * pricing.inputCostPer1M +
    (cachedInput / 1_000_000) * cachedRate;
  const outputUsd = (outputTokens / 1_000_000) * pricing.outputCostPer1M;
  return Math.round((inputUsd + outputUsd) * 10000) / 10000;
}

export function simulateMonthlyRoleCosts(input: CostSandboxInput): CostSandboxSimulation {
  const days = Math.max(1, Math.min(31, input.activeDaysPerMonth ?? 26));
  const cacheRatio = Math.min(0.95, Math.max(0, input.promptCacheHitRatio ?? 0.35));
  const basePreset = WORKLOAD_PRESETS[input.preset ?? "opc-standard"];
  const normalizedLedger = normalizeLedgerSnapshot(input.ledger);
  const roles: SugentAgentRole[] = ["assessor", "executor", "computerUse", "steward"];

  const executorPricing = readPricingFromCatalog(input.catalog, input.roleModels.executor) ?? {
    inputCostPer1M: 3.0,
    outputCostPer1M: 15.0,
  };

  const roleBreakdown = {} as Record<SugentAgentRole, RoleCostBreakdown>;
  let monthlyTotalUsd = 0;
  let allFlagshipBaselineUsd = 0;

  for (const role of roles) {
    const workload =
      input.customWorkload?.[role] ??
      normalizedLedger?.observedDailyWorkload?.[role] ??
      basePreset[role];

    const monthlyInputTokens = workload.dailyTasks * workload.avgInputTokensPerTask * days;
    const monthlyOutputTokens = workload.dailyTasks * workload.avgOutputTokensPerTask * days;
    const modelId = input.roleModels[role];
    const pricing = readPricingFromCatalog(input.catalog, modelId) ?? {
      inputCostPer1M: 0,
      outputCostPer1M: 0,
    };

    const monthlyUsd = computeTokenCostUsd(
      pricing,
      monthlyInputTokens,
      monthlyOutputTokens,
      cacheRatio,
    );
    const flagshipUsd = computeTokenCostUsd(
      executorPricing,
      monthlyInputTokens,
      monthlyOutputTokens,
      cacheRatio,
    );

    roleBreakdown[role] = {
      role,
      modelId,
      monthlyInputTokens,
      monthlyOutputTokens,
      monthlyUsd,
    };
    monthlyTotalUsd += monthlyUsd;
    allFlagshipBaselineUsd += flagshipUsd;
  }

  monthlyTotalUsd = Math.round(monthlyTotalUsd * 100) / 100;
  allFlagshipBaselineUsd = Math.round(allFlagshipBaselineUsd * 100) / 100;
  const monthlySavingsUsd = Math.max(
    0,
    Math.round((allFlagshipBaselineUsd - monthlyTotalUsd) * 100) / 100,
  );
  const savingsRatio =
    allFlagshipBaselineUsd > 0
      ? Math.round((monthlySavingsUsd / allFlagshipBaselineUsd) * 10000) / 10000
      : 0;

  const monthlyCapUsd = normalizedLedger?.monthlyCapUsd ?? null;
  const currentMonthSpentUsd = normalizedLedger?.currentMonthSpentUsd ?? 0;

  return {
    activeDaysPerMonth: days,
    promptCacheHitRatio: cacheRatio,
    roleBreakdown,
    monthlyTotalUsd,
    allFlagshipBaselineUsd,
    monthlySavingsUsd,
    savingsRatio,
    budgetHealth: {
      monthlyCapUsd,
      currentMonthSpentUsd,
      projectedExceedsCap: monthlyCapUsd !== null ? monthlyTotalUsd > monthlyCapUsd : false,
      remainingRunwayUsd:
        monthlyCapUsd !== null
          ? Math.round((monthlyCapUsd - currentMonthSpentUsd) * 100) / 100
          : null,
    },
  };
}
