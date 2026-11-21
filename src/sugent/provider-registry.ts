import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const HTTPS_PROTO = ["https", "://"].join("");
const HTTP_PROTO = ["http", "://"].join("");

export type LlmProviderPresetId =
  | "openai"
  | "anthropic"
  | "deepseek"
  | "gemini"
  | "gemini-web2api"
  | "openrouter"
  | "ollama"
  | "cowork"
  | "custom-openai"
  | "modelflare-legacy";

export interface LlmProviderPreset {
  id: LlmProviderPresetId;
  name: string;
  defaultBaseUrl: string;
  requiresApiKey: boolean;
}

export const LLM_PROVIDER_PRESETS: Readonly<
  Record<LlmProviderPresetId, LlmProviderPreset>
> = Object.freeze({
  openai: {
    id: "openai",
    name: "OpenAI",
    defaultBaseUrl: `${HTTPS_PROTO}api.openai.com/v1`,
    requiresApiKey: true,
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    defaultBaseUrl: `${HTTPS_PROTO}api.anthropic.com/v1`,
    requiresApiKey: true,
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    defaultBaseUrl: `${HTTPS_PROTO}api.deepseek.com/v1`,
    requiresApiKey: true,
  },
  gemini: {
    id: "gemini",
    name: "Google Gemini",
    defaultBaseUrl: `${HTTPS_PROTO}generativelanguage.googleapis.com/v1beta/openai`,
    requiresApiKey: true,
  },
  "gemini-web2api": {
    id: "gemini-web2api",
    name: "Gemini Web2API (Local Proxy)",
    defaultBaseUrl: `${HTTP_PROTO}127.0.0.1:8083/v1`,
    requiresApiKey: false,
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    defaultBaseUrl: `${HTTPS_PROTO}openrouter.ai/api/v1`,
    requiresApiKey: true,
  },
  ollama: {
    id: "ollama",
    name: "Ollama",
    defaultBaseUrl: `${HTTP_PROTO}127.0.0.1:11434/v1`,
    requiresApiKey: false,
  },
  cowork: {
    id: "cowork",
    name: "Cowork",
    defaultBaseUrl: `${HTTP_PROTO}127.0.0.1:28080/v1`,
    requiresApiKey: false,
  },
  "custom-openai": {
    id: "custom-openai",
    name: "Custom OpenAI-Compatible",
    defaultBaseUrl: "",
    requiresApiKey: false,
  },
  "modelflare-legacy": {
    id: "modelflare-legacy",
    name: "Legacy Connected Provider",
    defaultBaseUrl: "",
    requiresApiKey: true,
  },
});

export type SugentRoleKey = "assessor" | "executor" | "computerUse" | "steward";

export interface RoleRoutingConfig {
  assessor: string;
  executor: string;
  computerUse: string;
  steward: string;
}

export interface MagpieApiBases {
  chat: string;
  responses: string;
  anthropic: string;
}

export interface ProviderRecord {
  id: string;
  name: string;
  preset: LlmProviderPresetId;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  models?: string[];
  defaultModel?: string;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertProviderInput {
  id?: string;
  name?: string;
  preset?: LlmProviderPresetId;
  baseUrl?: string;
  apiKey?: string;
  enabled?: boolean;
  models?: string[];
  defaultModel?: string;
  setDefault?: boolean;
}

export interface PublicProviderItem {
  id: string;
  name: string;
  preset: LlmProviderPresetId;
  baseUrl: string;
  hasKey: boolean;
  keyTail: string;
  requiresApiKey: boolean;
  enabled: boolean;
  isDefault: boolean;
  models?: string[];
  defaultModel?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProviderRegistryPublicView {
  defaultProviderId: string | null;
  unlockSubscriptions: boolean;
  routing: RoleRoutingConfig;
  providers: PublicProviderItem[];
}

export interface LegacyProviderConfig {
  baseUrl?: string | null;
  apiKey?: string | null;
  name?: string;
  models?: string[];
  defaultModel?: string;
}

interface PersistedProviderRegistryFile {
  version: 1;
  defaultProviderId: string | null;
  unlockSubscriptions: boolean;
  routing: RoleRoutingConfig;
  providers: ProviderRecord[];
}

const REGISTRY_FILENAME = "sugent-providers.json";
const ROLE_KEYS: readonly SugentRoleKey[] = [
  "assessor",
  "executor",
  "computerUse",
  "steward",
];

function createEmptyRouting(): RoleRoutingConfig {
  return {
    assessor: "",
    executor: "",
    computerUse: "",
    steward: "",
  };
}

export function normalizeProviderPresetId(value: unknown): LlmProviderPresetId {
  if (value === "custom") return "custom-openai";
  if (isValidPresetId(value)) return value;
  return "custom-openai";
}

export function isValidPresetId(value: unknown): value is LlmProviderPresetId {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(LLM_PROVIDER_PRESETS, value)
  );
}

/**
 * Normalizes a provider base URL, stripping trailing slashes and removing any
 * tracking query parameters (`utm_*`).
 */
export function sanitizeProviderBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const parsed = new URL(trimmed);
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_")) {
        parsed.searchParams.delete(key);
      }
    }
    let formatted = parsed.toString();
    if (parsed.pathname === "/" && !parsed.search && !parsed.hash) {
      formatted = `${parsed.protocol}//${parsed.host}`;
    } else {
      formatted = formatted.replace(/\/+$/, "");
    }
    return formatted;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

function stripTrailingV1(baseUrl: string): string {
  const normalized = sanitizeProviderBaseUrl(baseUrl);
  if (!normalized) {
    return "";
  }
  return normalized.replace(/\/v1$/i, "");
}

function ensureTrailingV1(baseUrl: string): string {
  const normalized = sanitizeProviderBaseUrl(baseUrl);
  if (!normalized) {
    return "";
  }
  return /\/v1$/i.test(normalized) ? normalized : `${normalized}/v1`;
}

/**
 * Derives Magpie protocol base URLs (`{ chat, responses, anthropic }`) for a provider.
 */
export function deriveMagpieApiBases(
  provider: Pick<ProviderRecord, "preset" | "baseUrl">,
): MagpieApiBases {
  const rawBase =
    provider.baseUrl.trim() ||
    LLM_PROVIDER_PRESETS[provider.preset].defaultBaseUrl;
  const normalized = sanitizeProviderBaseUrl(rawBase);

  if (!normalized) {
    return { chat: "", responses: "", anthropic: "" };
  }

  switch (provider.preset) {
    case "anthropic": {
      const root = stripTrailingV1(normalized);
      const v1 = ensureTrailingV1(normalized);
      return {
        chat: v1,
        responses: "",
        anthropic: root,
      };
    }
    case "openai": {
      return {
        chat: normalized,
        responses: normalized,
        anthropic: "",
      };
    }
    case "gemini-web2api": {
      const v1 = ensureTrailingV1(normalized);
      return {
        chat: v1,
        responses: v1,
        anthropic: "",
      };
    }
    case "cowork":
    case "modelflare-legacy": {
      const root = stripTrailingV1(normalized);
      const v1 = ensureTrailingV1(normalized);
      return {
        chat: v1,
        responses: v1,
        anthropic: root,
      };
    }
    case "deepseek":
    case "gemini":
    case "openrouter":
    case "ollama":
    case "custom-openai": {
      return {
        chat: normalized,
        responses: "",
        anthropic: "",
      };
    }
  }
}

function maskKeyTail(apiKey: string): { hasKey: boolean; keyTail: string } {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    return { hasKey: false, keyTail: "" };
  }
  const keyTail = trimmed.length > 4 ? trimmed.slice(-4) : "";
  return { hasKey: true, keyTail };
}

function writeAtomicJson600(targetPath: string, data: unknown): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const suffix = `${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}`;
  const tmpPath = path.join(
    dir,
    `.${path.basename(targetPath)}.${suffix}.tmp`,
  );
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  try {
    fs.writeFileSync(tmpPath, serialized, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Ignore cleanup errors on failed write.
    }
    throw err;
  }
}

function cloneProvider(record: ProviderRecord): ProviderRecord {
  const copy: ProviderRecord = {
    id: record.id,
    name: record.name,
    preset: record.preset,
    baseUrl: record.baseUrl,
    apiKey: record.apiKey,
    enabled: record.enabled,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  if (record.models !== undefined) {
    copy.models = [...record.models];
  }
  if (record.defaultModel !== undefined) {
    copy.defaultModel = record.defaultModel;
  }
  return copy;
}

export class ProviderRegistry {
  private readonly dataDir: string;
  private readonly filePath: string;
  private readonly providers = new Map<string, ProviderRecord>();
  private defaultProviderId: string | null = null;
  private unlockSubscriptionsFlag = false;
  private roleRouting: RoleRoutingConfig = createEmptyRouting();

  constructor(dataDirOrOptions: string | { dataDir: string }) {
    this.dataDir =
      typeof dataDirOrOptions === "string"
        ? dataDirOrOptions
        : dataDirOrOptions.dataDir;
    this.filePath = path.join(this.dataDir, REGISTRY_FILENAME);
    this.loadFromDisk();
  }

  get unlockSubscriptions(): boolean {
    return this.unlockSubscriptionsFlag;
  }

  get routing(): RoleRoutingConfig {
    return { ...this.roleRouting };
  }

  hasActiveConnection(): boolean {
    if (this.unlockSubscriptionsFlag) return true;
    for (const p of this.providers.values()) {
      if (p.enabled) return true;
    }
    return false;
  }

  getUnlockSubscriptions(): boolean {
    return this.unlockSubscriptionsFlag;
  }

  setUnlockSubscriptions(enabled: boolean): boolean {
    this.unlockSubscriptionsFlag = Boolean(enabled);
    this.saveToDisk();
    return this.unlockSubscriptionsFlag;
  }

  getRoleRouting(): RoleRoutingConfig {
    return { ...this.roleRouting };
  }

  setRoleRouting(
    patch: Partial<Record<SugentRoleKey, string | null | undefined>>,
  ): RoleRoutingConfig {
    for (const key of ROLE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        const val = patch[key];
        if (val !== undefined) {
          this.roleRouting[key] = val === null ? "" : val.trim();
        }
      }
    }
    this.saveToDisk();
    return { ...this.roleRouting };
  }

  listProviders(): ProviderRecord[] {
    return [...this.providers.values()].map(cloneProvider);
  }

  getProvider(id: string): ProviderRecord | undefined {
    const found = this.providers.get(id);
    return found ? cloneProvider(found) : undefined;
  }

  getDefaultProviderId(): string | null {
    return this.defaultProviderId;
  }

  getDefaultProvider(): ProviderRecord | undefined {
    if (!this.defaultProviderId) {
      return undefined;
    }
    return this.getProvider(this.defaultProviderId);
  }

  upsertProvider(input: UpsertProviderInput, nowMs = Date.now()): ProviderRecord {
    const requestedId = input.id?.trim();
    const existing = requestedId ? this.providers.get(requestedId) : undefined;

    const preset: LlmProviderPresetId =
      input.preset ?? existing?.preset ?? "custom-openai";
    if (!isValidPresetId(preset)) {
      throw new Error(`Unsupported LLM provider preset: ${String(preset)}`);
    }

    const presetMeta = LLM_PROVIDER_PRESETS[preset];
    const id = this.resolveProviderId(requestedId, preset, Boolean(existing));

    const rawBaseUrl =
      input.baseUrl !== undefined
        ? input.baseUrl
        : (existing?.baseUrl ?? presetMeta.defaultBaseUrl);
    const baseUrl = sanitizeProviderBaseUrl(rawBaseUrl);

    const apiKey =
      input.apiKey !== undefined
        ? input.apiKey.trim()
        : (existing?.apiKey ?? "");

    const name =
      input.name?.trim() ||
      existing?.name ||
      presetMeta.name;

    const enabled =
      input.enabled !== undefined ? Boolean(input.enabled) : (existing?.enabled ?? true);

    const record: ProviderRecord = {
      id,
      name,
      preset,
      baseUrl,
      apiKey,
      enabled,
      createdAt: existing?.createdAt ?? nowMs,
      updatedAt: nowMs,
    };

    const models = input.models !== undefined ? input.models : existing?.models;
    if (models !== undefined) {
      record.models = models.map((m) => m.trim()).filter(Boolean);
    }

    const defaultModel =
      input.defaultModel !== undefined
        ? input.defaultModel.trim()
        : existing?.defaultModel;
    if (defaultModel) {
      record.defaultModel = defaultModel;
    }

    this.providers.set(id, record);

    if (
      input.setDefault === true ||
      this.defaultProviderId === null ||
      !this.providers.has(this.defaultProviderId)
    ) {
      this.defaultProviderId = id;
    }

    this.saveToDisk();
    return cloneProvider(record);
  }

  removeProvider(id: string): boolean {
    const existed = this.providers.delete(id);
    if (!existed) {
      return false;
    }

    if (this.defaultProviderId === id) {
      const remaining = [...this.providers.values()];
      const nextDefault =
        remaining.find((item) => item.enabled) ?? remaining[0];
      this.defaultProviderId = nextDefault ? nextDefault.id : null;
    }

    this.saveToDisk();
    return true;
  }

  setDefaultProvider(id: string): ProviderRecord {
    const target = this.providers.get(id);
    if (!target) {
      throw new Error(`Provider not found: ${id}`);
    }
    this.defaultProviderId = id;
    this.saveToDisk();
    return cloneProvider(target);
  }

  deriveMagpieApiBases(
    providerOrId: string | Pick<ProviderRecord, "preset" | "baseUrl">,
  ): MagpieApiBases {
    if (typeof providerOrId === "string") {
      const record = this.providers.get(providerOrId);
      if (!record) {
        throw new Error(`Provider not found: ${providerOrId}`);
      }
      return deriveMagpieApiBases(record);
    }
    return deriveMagpieApiBases(providerOrId);
  }

  resolveModelTarget(spec: string): {
    provider: ProviderRecord | undefined;
    model: string;
  } {
    const trimmed = spec.trim();
    if (!trimmed) {
      const defaultProvider = this.getDefaultProvider();
      return {
        provider: defaultProvider,
        model: defaultProvider?.defaultModel ?? "",
      };
    }

    const slashIndex = trimmed.indexOf("/");
    if (slashIndex > 0) {
      const candidateProviderId = trimmed.slice(0, slashIndex);
      const restModel = trimmed.slice(slashIndex + 1);
      const matched = this.getProvider(candidateProviderId);
      if (matched && restModel) {
        return { provider: matched, model: restModel };
      }
    }

    return {
      provider: this.getDefaultProvider(),
      model: trimmed,
    };
  }

  publicView(): ProviderRegistryPublicView {
    const items: PublicProviderItem[] = [];
    for (const record of this.providers.values()) {
      const { hasKey, keyTail } = maskKeyTail(record.apiKey);
      const presetMeta = LLM_PROVIDER_PRESETS[record.preset];
      const item: PublicProviderItem = {
        id: record.id,
        name: record.name,
        preset: record.preset,
        baseUrl: record.baseUrl,
        hasKey,
        keyTail,
        requiresApiKey: presetMeta.requiresApiKey,
        enabled: record.enabled,
        isDefault: record.id === this.defaultProviderId,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
      if (record.models !== undefined) {
        item.models = [...record.models];
      }
      if (record.defaultModel !== undefined) {
        item.defaultModel = record.defaultModel;
      }
      items.push(item);
    }

    return {
      defaultProviderId: this.defaultProviderId,
      unlockSubscriptions: this.unlockSubscriptionsFlag,
      routing: { ...this.roleRouting },
      providers: items,
    };
  }

  adoptLegacyProviderIfEmpty(
    legacy: LegacyProviderConfig | null | undefined,
    nowMs = Date.now(),
  ): ProviderRecord | null {
    if (this.providers.size > 0 || !legacy) {
      return null;
    }

    const baseUrl = sanitizeProviderBaseUrl(legacy.baseUrl ?? "");
    const apiKey = (legacy.apiKey ?? "").trim();

    if (!baseUrl || !apiKey) {
      return null;
    }

    const upsertInput: UpsertProviderInput = {
      id: "modelflare-legacy",
      name: legacy.name?.trim() || LLM_PROVIDER_PRESETS["modelflare-legacy"].name,
      preset: "modelflare-legacy",
      baseUrl,
      apiKey,
      enabled: true,
      setDefault: true,
    };
    if (legacy.models !== undefined) {
      upsertInput.models = legacy.models;
    }
    if (legacy.defaultModel !== undefined) {
      upsertInput.defaultModel = legacy.defaultModel;
    }

    return this.upsertProvider(upsertInput, nowMs);
  }

  private resolveProviderId(
    requestedId: string | undefined,
    preset: LlmProviderPresetId,
    isExisting: boolean,
  ): string {
    if (requestedId) {
      const sanitized = requestedId.replace(/\//g, "-").trim();
      if (!sanitized) {
        throw new Error("Provider id cannot be empty");
      }
      return sanitized;
    }
    if (!isExisting && !this.providers.has(preset)) {
      return preset;
    }
    const randomSuffix = crypto.randomBytes(3).toString("hex");
    return `${preset}-${randomSuffix}`;
  }

  private loadFromDisk(): void {
    if (!fs.existsSync(this.filePath)) {
      return;
    }

    const raw = fs.readFileSync(this.filePath, "utf8").trim();
    if (!raw) {
      return;
    }

    const parsed = JSON.parse(raw) as Partial<PersistedProviderRegistryFile>;
    this.providers.clear();

    if (Array.isArray(parsed.providers)) {
      for (const entry of parsed.providers) {
        if (
          entry &&
          typeof entry.id === "string" &&
          entry.id.trim() &&
          isValidPresetId(entry.preset)
        ) {
          const cleanId = entry.id.trim();
          const record: ProviderRecord = {
            id: cleanId,
            name:
              typeof entry.name === "string" && entry.name.trim()
                ? entry.name.trim()
                : LLM_PROVIDER_PRESETS[entry.preset].name,
            preset: entry.preset,
            baseUrl:
              typeof entry.baseUrl === "string"
                ? sanitizeProviderBaseUrl(entry.baseUrl)
                : LLM_PROVIDER_PRESETS[entry.preset].defaultBaseUrl,
            apiKey: typeof entry.apiKey === "string" ? entry.apiKey.trim() : "",
            enabled: typeof entry.enabled === "boolean" ? entry.enabled : true,
            createdAt:
              typeof entry.createdAt === "number" ? entry.createdAt : Date.now(),
            updatedAt:
              typeof entry.updatedAt === "number" ? entry.updatedAt : Date.now(),
          };
          if (Array.isArray(entry.models)) {
            record.models = entry.models
              .filter((m): m is string => typeof m === "string")
              .map((m) => m.trim())
              .filter(Boolean);
          }
          if (typeof entry.defaultModel === "string" && entry.defaultModel.trim()) {
            record.defaultModel = entry.defaultModel.trim();
          }
          this.providers.set(cleanId, record);
        }
      }
    }

    this.unlockSubscriptionsFlag = Boolean(parsed.unlockSubscriptions);

    const routing = createEmptyRouting();
    if (parsed.routing && typeof parsed.routing === "object") {
      for (const key of ROLE_KEYS) {
        const val = parsed.routing[key];
        if (typeof val === "string") {
          routing[key] = val.trim();
        }
      }
    }
    this.roleRouting = routing;

    if (
      typeof parsed.defaultProviderId === "string" &&
      this.providers.has(parsed.defaultProviderId)
    ) {
      this.defaultProviderId = parsed.defaultProviderId;
    } else {
      const first = [...this.providers.values()][0];
      this.defaultProviderId = first ? first.id : null;
    }
  }

  private saveToDisk(): void {
    const payload: PersistedProviderRegistryFile = {
      version: 1,
      defaultProviderId: this.defaultProviderId,
      unlockSubscriptions: this.unlockSubscriptionsFlag,
      routing: { ...this.roleRouting },
      providers: [...this.providers.values()].map(cloneProvider),
    };
    writeAtomicJson600(this.filePath, payload);
  }
}
