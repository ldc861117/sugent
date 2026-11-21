import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const HTTP_PROTO = ["http", "://"].join("");

export const GEMINI_WEB2API_DEFAULT_BASE_URL = `${HTTP_PROTO}127.0.0.1:8083/v1`;

export type GeminiWeb2ApiTier = "ultra" | "pro" | "plus" | "free" | "offline";

export interface GeminiWeb2ApiUrls {
  rootUrl: string;
  v1BaseUrl: string;
  chatCompletionsUrl: string;
  responsesUrl: string;
  modelsUrl: string;
  mcpUrl: string;
  adminUrl: string;
}

export interface GeminiWeb2ApiProbeOptions {
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

export interface GeminiWeb2ApiProbeResult {
  ok: boolean;
  reachable: boolean;
  authRequired: boolean;
  authenticated: boolean;
  version: string;
  tier: GeminiWeb2ApiTier;
  models: string[];
  urls: GeminiWeb2ApiUrls;
  warnings: string[];
  error?: string | undefined;
}

export interface GeminiWeb2ApiExtractedMedia {
  kind: "image" | "audio" | "video";
  mimeType: string;
  filePath: string;
  referenceUrl: string;
  byteLength: number;
  sha256: string;
  label: string;
}

export interface ExtractGeminiWeb2ApiMediaOptions {
  outputDir: string;
  publicPathPrefix?: string | undefined;
  minBase64Length?: number | undefined;
}

export interface ExtractGeminiWeb2ApiMediaResult {
  cleanedContent: string;
  artifacts: GeminiWeb2ApiExtractedMedia[];
}

export interface GeminiWeb2ApiMcpDescriptor {
  id: string;
  transport: "streamable-http";
  url: string;
  headers: Record<string, string>;
  tools: readonly string[];
}

export type GeminiWeb2ApiErrorKind =
  | "auth_failed"
  | "cookie_expired"
  | "payload_too_large"
  | "strict_model_unavailable"
  | "rate_limited"
  | "upstream_error";

export interface GeminiWeb2ApiErrorClassification {
  kind: GeminiWeb2ApiErrorKind;
  retryable: boolean;
  remediationZh: string;
  remediationEn: string;
}

const GEMINI_WEB2API_MCP_TOOLS = [
  "gemini_chat",
  "gemini_generate_image",
  "gemini_generate_music",
  "gemini_list_models",
] as const;

const MIME_EXTENSION_MAP: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveGeminiWeb2ApiUrls(baseUrl?: string): GeminiWeb2ApiUrls {
  const raw = (baseUrl ?? GEMINI_WEB2API_DEFAULT_BASE_URL).trim() || GEMINI_WEB2API_DEFAULT_BASE_URL;
  const trimmed = raw.replace(/\/+$/, "");
  const rootUrl = trimmed.endsWith("/v1")
    ? trimmed.slice(0, -3)
    : trimmed.replace(/\/v1\/(chat\/completions|responses|models)$/, "");
  const normalizedRoot = rootUrl.replace(/\/+$/, "");
  const v1BaseUrl = `${normalizedRoot}/v1`;

  return {
    rootUrl: normalizedRoot,
    v1BaseUrl,
    chatCompletionsUrl: `${v1BaseUrl}/chat/completions`,
    responsesUrl: `${v1BaseUrl}/responses`,
    modelsUrl: `${v1BaseUrl}/models`,
    mcpUrl: `${normalizedRoot}/mcp`,
    adminUrl: `${normalizedRoot}/admin/`,
  };
}

export function inferGeminiWeb2ApiTier(models: readonly string[]): GeminiWeb2ApiTier {
  if (models.length === 0) {
    return "offline";
  }
  const lower = new Set(models.map((m) => m.toLowerCase()));
  for (const id of lower) {
    if (id.startsWith("gemini-4-argon")) {
      return "ultra";
    }
  }
  for (const id of lower) {
    if (
      id.startsWith("gemini-3.1-pro") ||
      id.startsWith("gemini-3.7-flash") ||
      id.startsWith("gemini-3.8-flash")
    ) {
      return "pro";
    }
  }
  for (const id of lower) {
    if (id.startsWith("gemini-3.6-flash") || id.startsWith("gemini-2.5-pro")) {
      return "plus";
    }
  }
  return "free";
}

function collectModelIds(source: unknown, target: Set<string>): void {
  if (!Array.isArray(source)) {
    return;
  }
  for (const item of source) {
    if (typeof item === "string" && item.trim().length > 0) {
      target.add(item.trim());
    } else if (isRecord(item) && typeof item.id === "string" && item.id.trim().length > 0) {
      target.add(item.id.trim());
    }
  }
}

export async function probeGeminiWeb2Api(
  options?: GeminiWeb2ApiProbeOptions,
): Promise<GeminiWeb2ApiProbeResult> {
  const urls = resolveGeminiWeb2ApiUrls(options?.baseUrl);
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options?.timeoutMs ?? 5_000;
  const apiKey = options?.apiKey?.trim() ?? "";

  const warnings: string[] = [];
  const discoveredModels = new Set<string>();
  let reachable = false;
  let version = "";
  let authRequired = false;
  let authenticated = false;
  let lastError: string | undefined;

  const fetchWithTimeout = async (url: string, headers: Record<string, string>) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      return await fetchImpl(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const rootRes = await fetchWithTimeout(`${urls.rootUrl}/`, {
      Accept: "application/json",
    });
    reachable = true;
    if (rootRes.ok) {
      const rootJson: unknown = await rootRes.json().catch(() => null);
      if (isRecord(rootJson)) {
        if (typeof rootJson.version === "string") {
          version = rootJson.version;
        }
        collectModelIds(rootJson.models, discoveredModels);
      }
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }

  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey.length > 0) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const modelsRes = await fetchWithTimeout(urls.modelsUrl, headers);
    reachable = true;
    if (modelsRes.status === 401 || modelsRes.status === 403) {
      authRequired = true;
      authenticated = false;
      warnings.push(
        "gemini-web2api 已启用 API Key 鉴权，请填入反代后台签发的密钥（非 Google OAuth 令牌）。",
      );
    } else if (modelsRes.ok) {
      authenticated = true;
      const modelsJson: unknown = await modelsRes.json().catch(() => null);
      if (isRecord(modelsJson)) {
        collectModelIds(modelsJson.data, discoveredModels);
        collectModelIds(modelsJson.models, discoveredModels);
      }
    } else {
      lastError = `GET /v1/models failed with HTTP ${modelsRes.status}`;
    }
  } catch (err) {
    if (!reachable) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  const models = [...discoveredModels];
  const tier = reachable ? inferGeminiWeb2ApiTier(models) : "offline";

  if (reachable && models.length === 0 && !authRequired) {
    warnings.push(
      `反代服务在线但尚未发现可用模型，请打开 ${urls.adminUrl} 导入 Gemini 网页会话凭证（推荐使用 Firefox 导出以规避 Chrome DBSC 30 分钟轮换失效）。`,
    );
  }

  const ok = reachable && (!authRequired || authenticated);
  const result: GeminiWeb2ApiProbeResult = {
    ok,
    reachable,
    authRequired,
    authenticated,
    version,
    tier,
    models,
    urls,
    warnings,
  };
  if (!ok && lastError) {
    result.error = lastError;
  }
  return result;
}

export async function extractGeminiWeb2ApiInlineMedia(
  content: string,
  options: ExtractGeminiWeb2ApiMediaOptions,
): Promise<ExtractGeminiWeb2ApiMediaResult> {
  const minBase64Length = options.minBase64Length ?? 64;
  if (!content.includes("data:")) {
    return { cleanedContent: content, artifacts: [] };
  }

  const markdownDataUriPattern =
    /(!?)\[([^\]]*)\]\((data:((?:image|audio|video)\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+))\)/g;

  const matches = [...content.matchAll(markdownDataUriPattern)];
  if (matches.length === 0) {
    return { cleanedContent: content, artifacts: [] };
  }

  await fs.mkdir(options.outputDir, { recursive: true, mode: 0o700 });

  const artifacts: GeminiWeb2ApiExtractedMedia[] = [];
  let cursor = 0;
  const chunks: string[] = [];

  for (const match of matches) {
    const fullMatch = match[0];
    const bang = match[1] ?? "";
    const rawLabel = (match[2] ?? "").trim();
    const mimeType = (match[4] ?? "").toLowerCase();
    const rawBase64 = (match[5] ?? "").replace(/\s+/g, "");
    const matchIndex = match.index ?? 0;

    chunks.push(content.slice(cursor, matchIndex));
    cursor = matchIndex + fullMatch.length;

    const ext = MIME_EXTENSION_MAP[mimeType];
    if (!ext || rawBase64.length < minBase64Length) {
      chunks.push(fullMatch);
      continue;
    }

    const buffer = Buffer.from(rawBase64, "base64");
    if (buffer.byteLength === 0) {
      chunks.push(fullMatch);
      continue;
    }

    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    const fileName = `gemini-media-${sha256.slice(0, 12)}.${ext}`;
    const filePath = path.join(options.outputDir, fileName);
    await fs.writeFile(filePath, buffer, { mode: 0o600 });

    const kind: "image" | "audio" | "video" = mimeType.startsWith("image/")
      ? "image"
      : mimeType.startsWith("audio/")
        ? "audio"
        : "video";

    const prefix = options.publicPathPrefix
      ? options.publicPathPrefix.replace(/\/+$/, "")
      : "";
    const referenceUrl = prefix ? `${prefix}/${fileName}` : `file://${filePath}`;
    const label =
      rawLabel ||
      (kind === "image"
        ? "generated-image"
        : kind === "audio"
          ? "generated-audio"
          : "generated-video");

    artifacts.push({
      kind,
      mimeType,
      filePath,
      referenceUrl,
      byteLength: buffer.byteLength,
      sha256,
      label,
    });

    if (kind === "image" || bang === "!") {
      chunks.push(`![${label}](${referenceUrl})`);
    } else {
      chunks.push(`[${label}](${referenceUrl})`);
    }
  }

  chunks.push(content.slice(cursor));
  return {
    cleanedContent: chunks.join(""),
    artifacts,
  };
}

export function buildGeminiWeb2ApiMcpServer(options?: {
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  serverId?: string | undefined;
}): GeminiWeb2ApiMcpDescriptor {
  const urls = resolveGeminiWeb2ApiUrls(options?.baseUrl);
  const headers: Record<string, string> = {};
  const apiKey = options?.apiKey?.trim() ?? "";
  if (apiKey.length > 0) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return {
    id: options?.serverId?.trim() || "gemini-web2api-mcp",
    transport: "streamable-http",
    url: urls.mcpUrl,
    headers,
    tools: GEMINI_WEB2API_MCP_TOOLS,
  };
}

export function classifyGeminiWeb2ApiError(
  status: number,
  bodyText: string,
): GeminiWeb2ApiErrorClassification {
  const lower = bodyText.toLowerCase();

  if (status === 401 || status === 403 || lower.includes("invalid api key")) {
    return {
      kind: "auth_failed",
      retryable: false,
      remediationZh:
        "gemini-web2api 鉴权失败：请检查 API Key 是否为反代后台签发的网关密钥。",
      remediationEn:
        "gemini-web2api authentication failed: verify the proxy API key from the Admin UI.",
    };
  }

  if (
    lower.includes("1psid") ||
    lower.includes("cookie") ||
    lower.includes("unauthenticated") ||
    lower.includes("session expired") ||
    lower.includes("no available accounts")
  ) {
    return {
      kind: "cookie_expired",
      retryable: false,
      remediationZh:
        "Gemini 网页端会话凭证已失效或账号池为空：请前往 /admin/ 更新会话（建议使用 Firefox 导出以规避 Chrome DBSC 每 30 分钟强制失效）。",
      remediationEn:
        "Gemini web session expired or account pool is empty: refresh session in /admin/ (use Firefox export to avoid Chrome DBSC 30-min expiry).",
    };
  }

  if (
    status === 413 ||
    lower.includes("130kb") ||
    lower.includes("160kb") ||
    lower.includes("input too long") ||
    lower.includes("payload too large")
  ) {
    return {
      kind: "payload_too_large",
      retryable: true,
      remediationZh:
        "输入超过 Gemini 网页端单次 130KB–160KB UTF-8 上限，Sugent 上下文压缩管家应先裁剪历史消息后重试。",
      remediationEn:
        "Input exceeded Gemini Web 130KB–160KB UTF-8 limit; compact conversation context and retry.",
    };
  }

  if (
    lower.includes("strict_model") ||
    lower.includes("tier") ||
    lower.includes("model unavailable")
  ) {
    return {
      kind: "strict_model_unavailable",
      retryable: false,
      remediationZh:
        "当前账号订阅档位不支持所选模型（strict_model 已拒绝静默降级），请切换至 Flash 模型或升级反代号池。",
      remediationEn:
        "Selected model is unavailable for the active subscription tier (strict_model blocked silent downgrade).",
    };
  }

  if (status === 429 || lower.includes("rate limit") || lower.includes("quota")) {
    return {
      kind: "rate_limited",
      retryable: true,
      remediationZh:
        "触发 Gemini 网页端频率配额限制，请稍后重试或在 gemini-web2api /admin/ 中补充多账号轮询池。",
      remediationEn:
        "Gemini web rate limit reached; retry shortly or add more accounts in gemini-web2api /admin/.",
    };
  }

  return {
    kind: "upstream_error",
    retryable: status >= 500,
    remediationZh: `gemini-web2api 上游返回异常（HTTP ${status}），请检查反代日志与网络连接。`,
    remediationEn: `gemini-web2api upstream returned HTTP ${status}; check proxy logs and network connectivity.`,
  };
}
