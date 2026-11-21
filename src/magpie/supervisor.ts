import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lineLogger, logger, registerSecret } from "../log.js";
import { t } from "../i18n/index.js";
import { BOT_PROVIDER_PREFIX, MODELFLARE_PROVIDER, botProviderId, keyTail, modelflareApiBases } from "../modelflare.js";

const log = logger("magpie");
const LOOPBACK_HTTP = ["http", "://"].join("");

export interface MagpieOptions {
  dataDir: string;
  binPath?: string;
  gatewayPort?: number;
  webPort?: number;
  healthTimeoutMs?: number;
  unlockSubscriptions?: () => boolean;
}

export type MagpieState = "stopped" | "starting" | "running" | "restarting" | "failed";

interface Keys {
  webKey: string;
  gatewayKey: string;
  gatewayKeyRegistered?: boolean;
}

export interface GenericProviderSyncInput {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  apiBases: {
    chat: string;
    responses: string;
    anthropic: string;
  };
  headers?: Record<string, string>;
  picks?: string[];
}

export function findAppRoot(start = path.dirname(fileURLToPath(import.meta.url))): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    const pj = path.join(dir, "package.json");
    if (fs.existsSync(pj)) {
      try {
        if (JSON.parse(fs.readFileSync(pj, "utf8")).name === "anymodel-bot") return dir;
      } catch {
        /* ignore */
      }
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

export function magpieBinaryName(platform = process.platform, arch = process.arch): string {
  return `magpie-${platform}-${arch}${platform === "win32" ? ".exe" : ""}`;
}

export function resolveMagpieBinary(explicit?: string): string | undefined {
  const exe = process.platform === "win32" ? ".exe" : "";
  const candidates = [
    explicit,
    process.env.AMB_MAGPIE_BIN,
    (process as any).resourcesPath ? path.join((process as any).resourcesPath, "magpie", `magpie${exe}`) : undefined,
    path.join(findAppRoot(), "build", "bin", magpieBinaryName()),
    path.join(findAppRoot(), "build", "bin", `magpie${exe}`),
  ].filter(Boolean) as string[];
  return candidates.find((p) => fs.existsSync(p));
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function genKey(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export class MagpieSupervisor {
  state: MagpieState = "stopped";
  lastError = "";
  restarts = 0;
  gatewayPort = 0;
  webPort = 0;
  readonly binPath: string | undefined;
  private child: ChildProcess | undefined;
  private stopping = false;
  private keys!: Keys;
  private readonly root: string;
  private restartTimer: NodeJS.Timeout | undefined;
  private spawning: Promise<void> | undefined;
  private logTail: string[] = [];
  pid: number | undefined;
  lastExit: { code: number | null; signal: string | null; at: number } | undefined;

  constructor(private opts: MagpieOptions) {
    this.root = path.join(opts.dataDir, "magpie");
    this.binPath = resolveMagpieBinary(opts.binPath);
  }

  private subscriptionsUnlocked(): boolean {
    return (
      process.env.SUGENT_UNLOCK_SUBSCRIPTIONS === "1" ||
      process.env.SUGENT_UNLOCK_SUBSCRIPTIONS === "true" ||
      Boolean(this.opts.unlockSubscriptions?.())
    );
  }

  get baseUrl(): string {
    return `${LOOPBACK_HTTP}127.0.0.1:${this.gatewayPort}/v1`;
  }
  get gatewayKey(): string {
    return this.keys?.gatewayKey ?? "";
  }
  get webKey(): string {
    return this.keys?.webKey ?? "";
  }
  get webOrigin(): string {
    return `${LOOPBACK_HTTP}127.0.0.1:${this.webPort}`;
  }
  get cookieName(): string {
    return `magpie_web_${this.webPort}`;
  }
  get recentLog(): string[] {
    return this.logTail.slice(-50);
  }

  env(): NodeJS.ProcessEnv {
    const home = path.join(this.root, "home");
    const cfg = path.join(this.root, "config");
    const keep = ["PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR", "LANG", "TZ", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"];
    const env: NodeJS.ProcessEnv = {};
    for (const k of keep) if (process.env[k]) env[k] = process.env[k];
    const unlocked = this.subscriptionsUnlocked();
    return {
      ...env,
      HOME: unlocked && process.env.HOME ? process.env.HOME : home,
      USERPROFILE: unlocked && process.env.USERPROFILE ? process.env.USERPROFILE : home,
      XDG_CONFIG_HOME: cfg,
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      APPDATA: path.join(home, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(home, "AppData", "Local"),
      ...(unlocked ? {} : { MAGPIE_NO_ACCOUNTS: "1" }),
      MAGPIE_NO_STATS: "1",
      MAGPIE_NO_HANDOVER: "1",
      DO_NOT_TRACK: "1",
      MAGPIE_UPDATE_FEED: `${LOOPBACK_HTTP}127.0.0.1:9/disabled`,
      MAGPIE_WEB_KEY: this.keys.webKey,
      MAGPIE_ADDR: `127.0.0.1:${this.gatewayPort}`,
    };
  }

  private prepare(): void {
    const home = path.join(this.root, "home");
    const cfgDir = path.join(this.root, "config", "magpie");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
    const settingsPath = path.join(cfgDir, "settings.json");
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    } catch {
      /* new */
    }
    settings.noAutoUpdate = true;
    settings.noAccountDiscovery = !this.subscriptionsUnlocked();
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });

    const keysPath = path.join(this.root, "keys.json");
    try {
      this.keys = JSON.parse(fs.readFileSync(keysPath, "utf8"));
    } catch {
      this.keys = { webKey: genKey(), gatewayKey: "amb-" + genKey() };
    }
    this.saveKeys();
    registerSecret(this.keys.webKey);
    registerSecret(this.keys.gatewayKey);
    this.registerProviderKeys();
  }

  async applySubscriptionDiscoverySetting(): Promise<void> {
    if (!this.binPath) return;
    const wasRunning = this.state === "running";
    this.prepare();
    if (wasRunning) {
      await this.stop();
      await this.start();
    }
  }

  private registerProviderKeys(): void {
    const f = path.join(this.root, "config", "magpie", "providers.json");
    try {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      for (const p of Array.isArray(j) ? j : j.providers ?? []) registerSecret(String(p?.key ?? ""));
    } catch {
      /* empty */
    }
  }

  private saveKeys(): void {
    fs.writeFileSync(path.join(this.root, "keys.json"), JSON.stringify(this.keys), { mode: 0o600 });
  }

  runCli(args: string[], stdin?: string, timeoutMs = 20_000): Promise<{ code: number; stdout: string; stderr: string }> {
    if (!this.binPath) return Promise.reject(new Error(t("magpie.no_binary_cli")));
    if (!this.keys) this.prepare();
    return new Promise((resolve, reject) => {
      const p = spawn(this.binPath!, args, { env: this.env(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
      p.stdout.on("data", (d) => (stdout += d));
      p.stderr.on("data", (d) => (stderr += d));
      p.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      p.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });
      p.stdin.on("error", () => {});
      p.stdin.end(stdin ?? "");
    });
  }

  async start(): Promise<void> {
    if (!this.binPath) {
      this.state = "failed";
      this.lastError = t("magpie.no_binary");
      throw new Error(this.lastError);
    }
    this.stopping = false;
    this.prepare();
    this.reapStale();
    this.gatewayPort ||= this.opts.gatewayPort || (await freePort());
    this.webPort ||= this.opts.webPort || (await freePort());
    if (!this.keys.gatewayKeyRegistered) {
      const r = await this.runCli(["gateway-key", "add", "anymodel-bot", "--key", "-"], this.keys.gatewayKey);
      if (r.code === 0) {
        this.keys.gatewayKeyRegistered = true;
        this.saveKeys();
      } else log.warn("gateway-key add failed (loopback still works)", { stderr: r.stderr.slice(0, 200) });
    }
    await this.launch();
  }

  private async launch(): Promise<void> {
    try {
      await this.spawnOnce();
    } catch (e) {
      this.scheduleRestart();
      throw e;
    }
  }

  private spawnOnce(): Promise<void> {
    this.spawning ??= this.spawnChild().finally(() => (this.spawning = undefined));
    return this.spawning;
  }

  private async spawnChild(): Promise<void> {
    if (this.stopping) return;
    if (this.child) this.child.kill("SIGKILL");
    this.state = this.restarts ? "restarting" : "starting";
    const args = ["web", "--addr", `127.0.0.1:${this.webPort}`, "--no-open", "--gateway"];
    const child = spawn(this.binPath!, args, { env: this.env(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    this.pid = child.pid;
    if (child.pid) fs.writeFileSync(this.pidFile, String(child.pid));
    const keep = (safe: string) => {
      this.logTail.push(safe);
      if (this.logTail.length > 200) this.logTail.shift();
    };
    const out = lineLogger("magpie", "info", keep);
    const err = lineLogger("magpie", "info", keep);
    child.stdout?.on("data", (d) => out.push(d));
    child.stderr?.on("data", (d) => err.push(d));
    child.on("exit", (code, signal) => {
      out.flush();
      err.flush();
      this.lastExit = { code, signal, at: Date.now() };
      if (this.child !== child) return;
      this.child = undefined;
      if (this.stopping) {
        this.state = "stopped";
        return;
      }
      this.lastError = `magpie exited (code=${code}, signal=${signal})`;
      log.warn(this.lastError);
      if (this.state === "running") this.scheduleRestart();
    });
    try {
      await this.waitHealthy(this.opts.healthTimeoutMs ?? 20_000);
      if (this.child !== child) throw new Error("magpie exited during startup: " + this.recentLog.slice(-3).join(" | "));
      this.state = "running";
      log.info(`magpie running: gateway 127.0.0.1:${this.gatewayPort}, web 127.0.0.1:${this.webPort}`);
    } catch (e) {
      this.lastError = (e as Error).message;
      if (this.child === child) child.kill("SIGKILL");
      throw e;
    }
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer) return;
    this.restarts++;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.restarts, 6));
    this.state = "restarting";
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.stopping) return;
      this.launch().catch((e) => log.error("magpie restart failed", { message: (e as Error).message }));
    }, delay);
  }

  async healthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, { headers: { Authorization: `Bearer ${this.gatewayKey}` }, signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async waitHealthy(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.child) throw new Error("magpie exited during startup: " + this.recentLog.slice(-3).join(" | "));
      if (await this.healthy()) {
        try {
          const r = await fetch(this.webOrigin + "/", { headers: { Cookie: `${this.cookieName}=${this.webKey}` }, signal: AbortSignal.timeout(2000) });
          if (r.ok) return;
        } catch {
          /* retry */
        }
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("magpie health check timed out");
  }

  private get pidFile(): string {
    return path.join(this.root, "magpie.pid");
  }

  private reapStale(): void {
    let pid = 0;
    try {
      pid = Number(fs.readFileSync(this.pidFile, "utf8").trim());
    } catch {
      return;
    }
    if (!pid || pid === this.child?.pid) return;
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    let cmd = "";
    try {
      if (process.platform === "linux") cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
      else if (process.platform === "darwin") cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return;
    }
    if (this.binPath && cmd.includes(path.basename(this.binPath)) && cmd.includes(" web ")) {
      log.warn(`结束残留的 magpie 进程 ${pid}`);
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }

  killForTest(): void {
    this.child?.kill("SIGKILL");
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const child = this.child;
    if (!child) {
      await this.spawning?.catch(() => undefined);
      this.state = "stopped";
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill(process.platform === "win32" ? undefined : "SIGTERM");
    });
    await this.spawning?.catch(() => undefined);
    this.child = undefined;
    this.state = "stopped";
  }

  // ---------- 通用多服务商同步（解耦后主通道，不限定 URL 白名单，不注入专有归因头） ----------
  async upsertGenericProvider(input: GenericProviderSyncInput): Promise<void> {
    if (this.state !== "running") return;
    const effectiveKey = input.apiKey.trim() || "local-keyless";
    if (input.apiKey.trim()) registerSecret(input.apiKey.trim());
    let id = this.hasProvider(input.id) ? input.id : undefined;
    const addUrl = input.apiBases.chat || input.baseUrl;
    if (!id) {
      const add = await this.runCli(["provider", "add", input.name, `id=${input.id}`, `url=${addUrl}`, "key=placeholder-key"]);
      if (add.code !== 0) throw new Error(t("magpie.create_failed", { detail: (add.stderr || add.stdout).trim().slice(0, 300) }));
      id = this.hasProvider(input.id) ? input.id : await this.findProviderId(input.id);
    }
    await this.saveProvider(id, {
      ...input.apiBases,
      key: effectiveKey,
      headers: input.headers ?? {},
      ...(input.picks && input.picks.length ? { models: input.picks } : {}),
    });
  }

  async removeGenericProvider(id: string): Promise<void> {
    if (this.state !== "running") return;
    if (this.hasProvider(id)) await this.deleteProvider(id);
  }

  // ---------- Legacy Modelflare 兼容层 ----------
  async connectModelflare(apiKey: string, baseUrl: string, allowed: string[], headers: Record<string, string> = {}, picks: string[] = []): Promise<void> {
    await this.upsertProvider(this.modelflareId(), MODELFLARE_PROVIDER, "Modelflare", apiKey, baseUrl, allowed, headers, picks);
  }

  async setBotProvider(botId: string, apiKey: string, baseUrl: string, allowed: string[], headers: Record<string, string> = {}, picks: string[] = []): Promise<void> {
    const id = botProviderId(botId);
    await this.upsertProvider(this.hasProvider(id) ? id : undefined, id, `Modelflare ${botId}`, apiKey, baseUrl, allowed, headers, picks);
  }

  async setModelPicks(id: string, picks: string[]): Promise<void> {
    const cur = this.modelPicks(id);
    if (!picks.length || (cur.length === picks.length && picks.every((m) => cur.includes(m)))) return;
    await this.saveProvider(id, { models: picks });
  }

  modelPicks(id: string): string[] {
    const p = this.readProviderRaw(id);
    return Array.isArray(p?.models) ? p.models.map(String) : [];
  }

  private async upsertProvider(existing: string | undefined, wantId: string, name: string, apiKey: string, baseUrl: string, allowed: string[], headers: Record<string, string>, picks: string[]): Promise<void> {
    if (!allowed.includes(baseUrl)) throw new Error(t("magpie.unsupported_url"));
    if (!apiKey.trim()) throw new Error(t("magpie.missing_key"));
    registerSecret(apiKey.trim());
    let id = existing;
    if (!id) {
      const add = await this.runCli(["provider", "add", name, `id=${wantId}`, `url=${baseUrl}`, "key=placeholder-key"]);
      if (add.code !== 0) throw new Error(t("magpie.create_failed", { detail: (add.stderr || add.stdout).trim().slice(0, 300) }));
      id = this.hasProvider(wantId) ? wantId : await this.findProviderId(wantId);
    }
    await this.saveProvider(id, { ...modelflareApiBases(baseUrl), key: apiKey.trim(), headers, ...(picks.length ? { models: picks } : {}) });
  }

  async setModelflareUrl(baseUrl: string, allowed: string[]): Promise<void> {
    if (!allowed.includes(baseUrl)) throw new Error(t("magpie.unsupported_url"));
    for (const id of [this.modelflareId(), ...this.botProviderIds()]) if (id) await this.saveProvider(id, modelflareApiBases(baseUrl));
  }

  async ensureModelflareApis(id: string): Promise<void> {
    const p = this.readProviderRaw(id);
    const chat = typeof p?.chat === "string" ? p.chat : "";
    if (!chat) return;
    const want = modelflareApiBases(chat);
    if (p?.responses !== want.responses || p?.anthropic !== want.anthropic) await this.saveProvider(id, want);
  }

  nativeCompaction(id: string): boolean {
    return this.readProviderRaw(id)?.nativeCompaction === true;
  }

  private nativeSaving = new Map<string, Promise<void>>();
  private nativeFailedAt = new Map<string, number>();

  async ensureNativeCompaction(id: string): Promise<void> {
    if (this.nativeCompaction(id) || Date.now() - (this.nativeFailedAt.get(id) ?? 0) < 10 * 60_000) return;
    let p = this.nativeSaving.get(id);
    if (!p) {
      p = this.saveProvider(id, { nativeCompaction: true })
        .then(() => void this.nativeFailedAt.delete(id))
        .catch((e) => {
          this.nativeFailedAt.set(id, Date.now());
          throw e;
        })
        .finally(() => this.nativeSaving.delete(id));
      this.nativeSaving.set(id, p);
    }
    await p;
  }

  async disconnectModelflare(): Promise<void> {
    for (const id of [this.modelflareId(), ...this.botProviderIds()]) if (id) await this.deleteProvider(id);
  }

  async removeBotProvider(botId: string): Promise<void> {
    const id = botProviderId(botId);
    if (this.hasProvider(id)) await this.deleteProvider(id);
  }

  private async deleteProvider(id: string): Promise<void> {
    if (this.state !== "running") throw new Error(t("magpie.not_running"));
    const res = await fetch(`${this.webOrigin}/api/provider/delete`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${this.cookieName}=${this.webKey}`, origin: this.webOrigin },
      body: JSON.stringify({ id }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(t("magpie.disconnect_failed", { status: res.status, body: (await res.text()).slice(0, 200) }));
  }

  hasProvider(id: string): boolean {
    return this.listProviders().some((p) => p.id === id);
  }

  botProviderIds(): string[] {
    return this.listProviders()
      .map((p) => p.id)
      .filter((id) => id.startsWith(BOT_PROVIDER_PREFIX));
  }

  providerKey(id: string): string {
    const key = String(this.readProviderRaw(id)?.key ?? "");
    return key && key !== "placeholder-key" && key !== "local-keyless" ? key : "";
  }

  get modelflareProviderId(): string | undefined {
    return this.modelflareId();
  }

  modelflareInfo(): { connected: boolean; keyTail: string; baseUrl: string } {
    const id = this.modelflareId();
    const p = id ? this.readProviderRaw(id) : undefined;
    const key = String(p?.key ?? "");
    const connected = !!key && key !== "placeholder-key";
    return { connected, keyTail: connected ? keyTail(key) : "", baseUrl: String(p?.chat ?? "") };
  }

  upstreamEndpoint(providerId?: string): { id: string; baseUrl: string; apiKey: string } | undefined {
    const fallbackId = this.modelflareId() ?? this.listProviders()[0]?.id;
    const id = providerId && this.hasProvider(providerId) ? providerId : fallbackId;
    const p = id ? this.readProviderRaw(id) : undefined;
    const key = String(p?.key ?? "");
    if (!id || !p || !key || key === "placeholder-key") return undefined;
    if (key !== "local-keyless") registerSecret(key);
    return { id, baseUrl: String(p.chat ?? "").replace(/\/+$/, ""), apiKey: key === "local-keyless" ? "" : key };
  }

  private modelflareId(): string | undefined {
    const hit = this.listProviders().find((p) => p.id.toLowerCase() === MODELFLARE_PROVIDER || p.name.toLowerCase() === MODELFLARE_PROVIDER);
    return hit?.id;
  }

  private async saveProvider(id: string, patch: Record<string, unknown>): Promise<void> {
    if (this.state !== "running") throw new Error(t("magpie.not_running"));
    const p = this.readProviderRaw(id);
    if (!p) throw new Error(`provider ${id} not found`);
    const res = await fetch(`${this.webOrigin}/api/provider/save`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${this.cookieName}=${this.webKey}`, origin: this.webOrigin },
      body: JSON.stringify({ ...p, ...patch, from: id }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(t("magpie.save_failed", { status: res.status, body: (await res.text()).slice(0, 200) }));
    const saved = this.readProviderRaw(id);
    for (const [k, v] of Object.entries(patch)) if (JSON.stringify(saved?.[k] ?? {}) !== JSON.stringify(v ?? {})) throw new Error(t("magpie.verify_failed"));
  }

  private readProviderRaw(id: string): Record<string, unknown> | undefined {
    const f = path.join(this.root, "config", "magpie", "providers.json");
    if (!fs.existsSync(f)) return undefined;
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    const arr: any[] = Array.isArray(j) ? j : j.providers ?? [];
    return arr.find((x) => x.id === id);
  }

  listProviders(): Array<{ id: string; name: string }> {
    for (const f of ["providers.json", "config.json"]) {
      const p = path.join(this.root, "config", "magpie", f);
      if (!fs.existsSync(p)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(p, "utf8"));
        const arr = Array.isArray(j) ? j : Array.isArray(j.providers) ? j.providers : [];
        if (arr.length) return arr.map((x: any) => ({ id: String(x.id ?? ""), name: String(x.name ?? x.id ?? "") }));
      } catch {
        /* ignore */
      }
    }
    return [];
  }

  private async findProviderId(nameOrPreset: string): Promise<string> {
    const list = this.listProviders();
    const want = nameOrPreset.toLowerCase();
    const hit = [...list].reverse().find((p) => p.id.toLowerCase() === want || p.name.toLowerCase() === want || p.id.toLowerCase().startsWith(want));
    if (hit) return hit.id;
    const r = await this.runCli(["providers"]);
    const m = r.stdout.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
    const id = m.reverse().find((x) => x.toLowerCase().startsWith(want));
    if (!id) throw new Error(`could not determine provider id for ${nameOrPreset}`);
    return id;
  }
}
