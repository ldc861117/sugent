import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  classifyModelProfile,
  type ModelCapabilityProfile,
  type SugentModelCatalog,
} from "./model-catalog.js";
import {
  deriveMagpieApiBases,
  type ProviderRecord,
  type ProviderRegistry,
} from "./provider-registry.js";

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
  probe?: {
    probedAtIso: string;
    ok: boolean;
    ttftMs: number | null;
    toolCallingSupported: boolean | null;
  };
  circuit: ModelCircuitState;
}

export interface ProviderSyncResult {
  providerId: string;
  ok: boolean;
  discoveredCount: number;
  chatModelCount: number;
  addedModels: string[];
  removedModels: string[];
  skippedReason?: string;
  error?: string;
  syncedAtIso: string;
}

export interface ModelPoolSnapshot {
  lastSyncedAtIso: string | null;
  totalModels: number;
  chatModels: number;
  healthyChatModels: number;
  coolingChatModels: number;
  providersSynced: number;
  entries: SyncedModelEntry[];
}

function writeAtomic600(filePath: string, payload: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const suffix = `${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString("hex")}`;
  const tmp = path.join(dir, `.${path.basename(filePath)}.${suffix}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Ignore cleanup errors.
    }
    throw err;
  }
}

function buildHeaders(p: ProviderRecord): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (p.apiKey) {
    if (p.preset === "anthropic") {
      headers["x-api-key"] = p.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers.Authorization = `Bearer ${p.apiKey}`;
    }
  }
  return headers;
}

function resolveChatApiBase(p: ProviderRecord): string {
  const derived = deriveMagpieApiBases(p).chat;
  return (derived || p.baseUrl).replace(/\/+$/, "");
}

function defaultCircuit(): ModelCircuitState {
  return { state: "closed", consecutiveFailures: 0, cooldownUntilMs: 0 };
}

function cloneEntry(e: SyncedModelEntry): SyncedModelEntry {
  return {
    ...e,
    profile: {
      ...e.profile,
      modalities: [...e.profile.modalities],
      ...(e.profile.rates ? { rates: { ...e.profile.rates } } : {}),
    },
    ...(e.probe ? { probe: { ...e.probe } } : {}),
    circuit: { ...e.circuit },
  };
}

function parseRemoteModelIds(body: {
  data?: Array<{ id?: unknown }>;
  models?: Array<{ id?: unknown; name?: unknown }>;
}): string[] {
  const raw = Array.isArray(body.data)
    ? body.data.map((x) => String(x?.id ?? "").trim())
    : Array.isArray(body.models)
      ? body.models.map((x) => String(x?.id ?? x?.name ?? "").trim())
      : [];
  return Array.from(new Set(raw.filter(Boolean)));
}

export class ModelPoolSyncer {
  private readonly filePath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly nowMs: () => number;
  private entries = new Map<string, SyncedModelEntry>();
  private lastSyncedAtMs: number | null = null;

  constructor(
    private readonly opts: {
      dataDir: string;
      providers: ProviderRegistry;
      catalog: SugentModelCatalog;
      fetchImpl?: typeof fetch;
      nowMs?: () => number;
    },
  ) {
    this.filePath = path.join(opts.dataDir, "sugent-routing", "model-pool.json");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.load();
    this.seedConfiguredProviders();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as {
        lastSyncedAtIso?: string;
        entries?: SyncedModelEntry[];
      };
      this.lastSyncedAtMs = parsed.lastSyncedAtIso
        ? Date.parse(parsed.lastSyncedAtIso) || null
        : null;
      for (const e of parsed.entries ?? []) {
        if (!e?.targetId) continue;
        this.entries.set(e.targetId, {
          ...e,
          profile: classifyModelProfile(e.rawModelId, this.opts.catalog),
        });
      }
    } catch {
      // Ignore corrupt cache and rebuild from configured providers.
    }
  }

  private save(): void {
    writeAtomic600(this.filePath, {
      version: 1,
      lastSyncedAtIso: this.lastSyncedAtMs
        ? new Date(this.lastSyncedAtMs).toISOString()
        : null,
      entries: Array.from(this.entries.values()),
    });
  }

  private seedConfiguredProviders(): void {
    const nowIso = new Date(this.nowMs()).toISOString();
    let dirty = false;
    for (const p of this.opts.providers.listProviders()) {
      if (!p.enabled) continue;
      const configured =
        p.models && p.models.length > 0
          ? p.models
          : p.defaultModel
            ? [p.defaultModel]
            : [];
      for (const raw of configured) {
        const targetId = `${p.id}/${raw}`;
        const existing = this.entries.get(targetId);
        if (!existing) {
          const profile = classifyModelProfile(raw, this.opts.catalog);
          this.entries.set(targetId, {
            targetId,
            providerId: p.id,
            rawModelId: raw,
            bareModelId: profile.bareModelId,
            baseUrl: p.baseUrl,
            profile,
            discoveredAtIso: nowIso,
            lastSeenAtIso: nowIso,
            source: "configured",
            circuit: defaultCircuit(),
          });
          dirty = true;
        } else if (p.baseUrl && existing.baseUrl !== p.baseUrl) {
          existing.baseUrl = p.baseUrl;
          dirty = true;
        }
      }
    }
    if (dirty) this.save();
  }

  async syncAllEnabled(opts?: {
    force?: boolean;
    minIntervalMs?: number;
  }): Promise<{ results: ProviderSyncResult[]; snapshot: ModelPoolSnapshot }> {
    this.seedConfiguredProviders();
    const minInt = opts?.minIntervalMs ?? 600_000;
    const now = this.nowMs();
    if (!opts?.force && this.lastSyncedAtMs && now - this.lastSyncedAtMs < minInt) {
      return { results: [], snapshot: this.getPoolSnapshot(now) };
    }
    const results: ProviderSyncResult[] = [];
    for (const p of this.opts.providers.listProviders()) {
      if (p.enabled && p.baseUrl) {
        results.push(await this.syncProvider(p.id, { force: opts?.force }));
      }
    }
    return { results, snapshot: this.getPoolSnapshot(this.nowMs()) };
  }

  async syncProvider(
    providerId: string,
    opts?: { force?: boolean },
  ): Promise<ProviderSyncResult> {
    const p = this.opts.providers.getProvider(providerId);
    const now = this.nowMs();
    const syncedAtIso = new Date(now).toISOString();
    if (!p || !p.enabled || !p.baseUrl) {
      return {
        providerId, ok: false, discoveredCount: 0, chatModelCount: 0,
        addedModels: [], removedModels: [], skippedReason: "disabled_or_no_base_url", syncedAtIso,
      };
    }
    try {
      const res = await this.fetchImpl(`${resolveChatApiBase(p)}/models`, {
        headers: buildHeaders(p),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        return {
          providerId, ok: false, discoveredCount: 0, chatModelCount: 0,
          addedModels: [], removedModels: [], error: `HTTP ${res.status}`, syncedAtIso,
        };
      }
      const body = (await res.json()) as { data?: Array<{ id?: unknown }>; models?: Array<{ id?: unknown; name?: unknown }> };
      const rawIds = parseRemoteModelIds(body);
      const prevSet = new Set(Array.from(this.entries.values()).filter((e) => e.providerId === providerId).map((e) => e.rawModelId));
      const nextSet = new Set(rawIds);
      const addedModels = rawIds.filter((m) => !prevSet.has(m));
      const removedModels = rawIds.length > 0 ? Array.from(prevSet).filter((m) => !nextSet.has(m)) : [];
      for (const rem of removedModels) this.entries.delete(`${providerId}/${rem}`);
      for (const raw of rawIds) {
        const targetId = `${providerId}/${raw}`;
        const prev = this.entries.get(targetId);
        const profile = classifyModelProfile(raw, this.opts.catalog);
        const circuit = prev?.circuit
          ? prev.circuit.needsResync
            ? defaultCircuit()
            : { ...prev.circuit }
          : defaultCircuit();
        if (prev?.circuit?.needsResync) circuit.needsResync = false;
        this.entries.set(targetId, {
          targetId, providerId, rawModelId: raw, bareModelId: profile.bareModelId, baseUrl: p.baseUrl, profile,
          discoveredAtIso: prev?.discoveredAtIso ?? syncedAtIso, lastSeenAtIso: syncedAtIso, source: "remote_sync",
          ...(prev?.probe ? { probe: prev.probe } : {}), circuit,
        });
      }
      if (rawIds.length > 0) {
        const firstChat = rawIds.find((r) => classifyModelProfile(r, this.opts.catalog).isChatModel) ?? rawIds[0];
        this.opts.providers.upsertProvider({ id: p.id, models: rawIds, ...(p.defaultModel || !opts?.force ? {} : { defaultModel: firstChat }) }, now);
      }
      this.lastSyncedAtMs = now;
      this.save();
      const chatModelCount = rawIds.filter((r) => classifyModelProfile(r, this.opts.catalog).isChatModel).length;
      return { providerId, ok: true, discoveredCount: rawIds.length, chatModelCount, addedModels, removedModels, syncedAtIso };
    } catch (err) {
      return {
        providerId, ok: false, discoveredCount: 0, chatModelCount: 0,
        addedModels: [], removedModels: [], error: err instanceof Error ? err.message : String(err), syncedAtIso,
      };
    }
  }

  async probeUnknownModels(opts?: {
    maxProbes?: number;
    timeoutMs?: number;
  }): Promise<number> {
    const limit = opts?.maxProbes ?? 2;
    const timeoutMs = opts?.timeoutMs ?? 6_000;
    let count = 0;
    for (const e of this.entries.values()) {
      if (count >= limit) break;
      if (!e.profile.isChatModel || !e.profile.inferredFromFallback || e.probe) continue;
      if (!this.isModelAvailable(e.targetId)) continue;
      const p = this.opts.providers.getProvider(e.providerId);
      if (!p || !p.enabled || !p.baseUrl) continue;
      const t0 = this.nowMs();
      try {
        const res = await this.fetchImpl(`${resolveChatApiBase(p)}/chat/completions`, {
          method: "POST",
          headers: buildHeaders(p),
          body: JSON.stringify({
            model: e.rawModelId,
            max_tokens: 16,
            messages: [{ role: "user", content: "ping" }],
            tools: [{
              type: "function",
              function: { name: "ping", parameters: { type: "object", properties: {} } },
            }],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const ttftMs = Math.max(1, this.nowMs() - t0);
        const json = res.ok
          ? ((await res.json().catch(() => ({}))) as {
              choices?: Array<{ message?: { tool_calls?: unknown[] } }>;
            })
          : undefined;
        e.probe = {
          probedAtIso: new Date(this.nowMs()).toISOString(),
          ok: res.ok,
          ttftMs: res.ok ? ttftMs : null,
          toolCallingSupported: res.ok ? Boolean(json?.choices?.[0]?.message) : false,
        };
      } catch {
        e.probe = {
          probedAtIso: new Date(this.nowMs()).toISOString(),
          ok: false,
          ttftMs: null,
          toolCallingSupported: null,
        };
      }
      count += 1;
    }
    if (count > 0) this.save();
    return count;
  }

  recordInfraFailure(
    targetId: string,
    status: number | "timeout" | "network",
    atMs = this.nowMs(),
  ): ModelCircuitState {
    const entry = this.entries.get(targetId);
    const cur: ModelCircuitState = entry
      ? { ...entry.circuit }
      : defaultCircuit();
    cur.consecutiveFailures += 1;
    cur.lastErrorCode = String(status);
    cur.lastFailureAtIso = new Date(atMs).toISOString();
    if (status === 429) {
      cur.state = "open";
      cur.cooldownUntilMs =
        atMs + 60_000 * Math.min(15, 3 ** (cur.consecutiveFailures - 1));
    } else if (status === 401 || status === 403 || status === 404) {
      cur.state = "open";
      cur.cooldownUntilMs = atMs + 1_800_000;
      if (status === 404) cur.needsResync = true;
    } else if (cur.consecutiveFailures >= 2) {
      cur.state = "open";
      cur.cooldownUntilMs =
        atMs + 120_000 * Math.min(5, cur.consecutiveFailures - 1);
    }
    if (entry) {
      entry.circuit = cur;
      this.save();
    }
    return { ...cur };
  }

  recordInfraSuccess(targetId: string, _atMs = this.nowMs()): ModelCircuitState {
    const entry = this.entries.get(targetId);
    const next: ModelCircuitState = defaultCircuit();
    if (entry) {
      entry.circuit = next;
      this.save();
    }
    return { ...next };
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
    const enabledIds = new Set(
      this.opts.providers.listProviders().filter((p) => p.enabled).map((p) => p.id),
    );
    const list: SyncedModelEntry[] = [];
    for (const e of this.entries.values()) {
      if (!enabledIds.has(e.providerId) || !e.profile.isChatModel) continue;
      this.isModelAvailable(e.targetId, atMs);
      list.push(cloneEntry(e));
    }
    return list;
  }

  getEntry(targetId: string): SyncedModelEntry | undefined {
    const e = this.entries.get(targetId);
    return e ? cloneEntry(e) : undefined;
  }

  getPoolSnapshot(atMs = this.nowMs()): ModelPoolSnapshot {
    this.seedConfiguredProviders();
    const enabledIds = new Set(
      this.opts.providers.listProviders().filter((p) => p.enabled).map((p) => p.id),
    );
    const healthyIds = new Set<string>();
    const entries: SyncedModelEntry[] = [];
    for (const e of this.entries.values()) {
      if (!enabledIds.has(e.providerId)) continue;
      if (e.profile.isChatModel && this.isModelAvailable(e.targetId, atMs)) {
        healthyIds.add(e.targetId);
      }
      entries.push(cloneEntry(e));
    }
    const chat = entries.filter((e) => e.profile.isChatModel);
    return {
      lastSyncedAtIso: this.lastSyncedAtMs
        ? new Date(this.lastSyncedAtMs).toISOString()
        : null,
      totalModels: entries.length,
      chatModels: chat.length,
      healthyChatModels: healthyIds.size,
      coolingChatModels: chat.length - healthyIds.size,
      providersSynced: new Set(entries.map((e) => e.providerId)).size,
      entries,
    };
  }
}
