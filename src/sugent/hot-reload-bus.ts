import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getOverlayRepoDir, inspectSelfEvolutionPlugins, type SelfEvolutionPluginIssue } from "./self-evolution.js";

export type HotReloadEventType = "core_hello" | "ui_change" | "extension_reloaded" | "core_reloading";

export interface HotReloadEvent {
  type: HotReloadEventType;
  atMs: number;
  bootId: string;
  buildId?: string;
  kind?: "css" | "reload";
  file?: string;
  pluginCount?: number;
  validIds?: string[];
  reason?: string;
}

export interface HotReloadBusOptions {
  bootId?: string;
  buildId?: string;
  dataDir: string;
  uiDir: string;
  enableWatchers?: boolean;
  debounceMs?: number;
  onExtensionReloaded?: (info: { pluginCount: number; validIds: string[] }) => void;
}

function writeSseEvent(res: http.ServerResponse, id: number, ev: HotReloadEvent): void {
  if (res.writableEnded || res.destroyed) return;
  try {
    res.write(`id: ${id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  } catch {
    /* ignore closed client */
  }
}

export class HotReloadBus {
  readonly bootId: string;
  private buildId?: string;
  private seq = 0;
  private clients = new Set<http.ServerResponse>();
  private watchers: fs.FSWatcher[] = [];
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private closed = false;
  private lastExtensions: { pluginCount: number; validIds: string[]; issues: SelfEvolutionPluginIssue[]; reloadedAtIso: string };

  constructor(private readonly opts: HotReloadBusOptions) {
    this.bootId = opts.bootId || `boot-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    this.buildId = opts.buildId;
    const initExt = inspectSelfEvolutionPlugins(opts.dataDir);
    this.lastExtensions = {
      pluginCount: initExt.plugins.length,
      validIds: initExt.plugins.map((p) => p.id),
      issues: initExt.issues,
      reloadedAtIso: new Date().toISOString(),
    };
    if (opts.enableWatchers) this.startWatchers();
  }
  setBuildId(buildId: string): void {
    this.buildId = buildId;
  }

  getSnapshot() {
    return {
      bootId: this.bootId,
      ...(this.buildId ? { buildId: this.buildId } : {}),
      sseClients: this.clients.size,
      watchersActive: this.watchers.length,
      extensions: this.lastExtensions,
    };
  }

  private emit(partial: Omit<HotReloadEvent, "atMs" | "bootId" | "buildId">): HotReloadEvent {
    const ev: HotReloadEvent = {
      ...partial,
      atMs: Date.now(),
      bootId: this.bootId,
      ...(this.buildId ? { buildId: this.buildId } : {}),
    };
    this.seq += 1;
    for (const res of [...this.clients]) {
      if (res.writableEnded || res.destroyed) this.clients.delete(res);
      else writeSseEvent(res, this.seq, ev);
    }
    return ev;
  }

  attachSse(res: http.ServerResponse): () => void {
    if (this.closed) {
      res.writeHead(503).end();
      return () => {};
    }
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
    this.clients.add(res);
    this.seq += 1;
    writeSseEvent(res, this.seq, { type: "core_hello", atMs: Date.now(), bootId: this.bootId, ...(this.buildId ? { buildId: this.buildId } : {}) });
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        for (const c of [...this.clients]) if (!c.writableEnded && !c.destroyed) c.write(": ping\n\n");
      }, 25_000);
      this.heartbeatTimer.unref();
    }
    const off = () => this.clients.delete(res);
    res.on("close", off);
    return off;
  }

  notifyUiChange(file: string): HotReloadEvent {
    const clean = String(file || "ui/main.js").replace(/\\/g, "/");
    return this.emit({ type: "ui_change", kind: clean.toLowerCase().endsWith(".css") ? "css" : "reload", file: clean });
  }

  notifyCoreReloading(reason = "hot_reload"): HotReloadEvent {
    return this.emit({ type: "core_reloading", reason });
  }

  reloadExtensions() {
    const res = inspectSelfEvolutionPlugins(this.opts.dataDir);
    this.lastExtensions = {
      pluginCount: res.plugins.length,
      validIds: res.plugins.map((p) => p.id),
      issues: res.issues,
      reloadedAtIso: new Date().toISOString(),
    };
    this.opts.onExtensionReloaded?.({ pluginCount: this.lastExtensions.pluginCount, validIds: this.lastExtensions.validIds });
    this.emit({ type: "extension_reloaded", pluginCount: this.lastExtensions.pluginCount, validIds: this.lastExtensions.validIds });
    return this.lastExtensions;
  }
  async loadHotPluginModule(filePath: string): Promise<Record<string, unknown>> {
    const abs = path.resolve(filePath);
    const st = fs.statSync(abs);
    const href = `${pathToFileURL(abs).href}?v=${Math.round(st.mtimeMs)}-${crypto.randomBytes(2).toString("hex")}`;
    return (await import(href)) as Record<string, unknown>;
  }

  startWatchers(): void {
    if (this.closed || this.watchers.length > 0) return;
    const ms = Math.max(40, this.opts.debounceMs ?? 120);
    const schedule = (key: string, fn: () => void) => {
      const prev = this.debounceTimers.get(key);
      if (prev) clearTimeout(prev);
      const t = setTimeout(() => { this.debounceTimers.delete(key); fn(); }, ms);
      t.unref();
      this.debounceTimers.set(key, t);
    };
    const watchDir = (dir: string, keyPrefix: string, handler: (rel: string) => void) => {
      if (!fs.existsSync(dir)) return;
      try {
        const w = fs.watch(dir, { recursive: true }, (_ev, filename) => {
          const rel = String(filename ?? "").replace(/\\/g, "/");
          if (!rel || rel.startsWith(".") || rel.includes("/.") || rel.endsWith(".tmp")) return;
          schedule(`${keyPrefix}:${rel}`, () => handler(rel));
        });
        this.watchers.push(w);
      } catch { /* ignore unsupported recursive fs.watch on platform */ }
    };
    watchDir(this.opts.uiDir, "ui", (rel) => this.notifyUiChange(rel));
    watchDir(path.join(getOverlayRepoDir(this.opts.dataDir), "plugins"), "ext", () => void this.reloadExtensions());
  }

  close(): void {
    this.closed = true;
    for (const w of this.watchers) { try { w.close(); } catch { /* ignore */ } }
    this.watchers = [];
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    this.debounceTimers.clear();
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = undefined; }
    for (const res of [...this.clients]) {
      try { if (!res.writableEnded && !res.destroyed) res.end(); } catch { /* ignore */ }
    }
    this.clients.clear();
  }
}
