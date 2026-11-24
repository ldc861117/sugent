import { execFile, spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { HotBundleSlotManager, type HotBootSlot, type HotBundleSlotState } from "./hot-bundle-slots.js";

export interface CoreReadyInfo {
  pid: number;
  url: string;
  port: number;
  token: string;
  bootId: string;
  buildId?: string;
  version?: string;
  slot: HotBootSlot;
}

export interface HotUpdateStatusSnapshot {
  supervised: boolean;
  running: boolean;
  reloading: boolean;
  activeSlot: HotBootSlot;
  reloadCount: number;
  lastReloadMs: number | null;
  lastError?: string;
  currentCore?: CoreReadyInfo;
  slots: HotBundleSlotState;
}

export interface HotCoreSupervisorOptions {
  dataDir: string;
  defaultEntryPath: string;
  defaultUiDir: string;
  hostNodeModulesDir?: string;
  port?: number;
  token?: string;
  nodeExecPath?: string;
  nodeArgs?: string[];
  extraEnv?: Record<string, string>;
  healthTimeoutMs?: number;
  drainTimeoutMs?: number;
  slotManager?: HotBundleSlotManager;
  desktopRpcHandler?: (method: string, args: unknown[]) => Promise<unknown> | unknown;
  onCoreReady?: (info: CoreReadyInfo) => void;
  onCoreLog?: (line: string) => void;
  onAttention?: (items: unknown[]) => void;
  onCoreExit?: (code: number | null) => void;
}

function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function runCommand(argv: readonly string[], cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(argv[0]!, argv.slice(1), { cwd, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? Number((err as { code: number }).code) : err ? 1 : 0;
      resolve({ code, output: `${stdout ?? ""}\n${stderr ?? ""}`.trim().slice(-1200) });
    });
  });
}
function defaultNodeModulesNearEntry(entryPath: string): string | undefined {
  let cur = path.dirname(path.resolve(entryPath));
  for (let i = 0; i < 6; i++) {
    const nm = path.join(cur, "node_modules");
    if (!nm.includes(".asar") && fs.existsSync(nm)) return nm;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return undefined;
}

export class HotCoreSupervisor {
  readonly slotManager: HotBundleSlotManager;
  private readonly hostNodeModulesDir?: string;
  private boundPort = 0;
  private readonly token: string;
  private child: ChildProcess | undefined;
  private currentCore: CoreReadyInfo | undefined;
  private reloading = false;
  private stopping = false;
  private reloadCount = 0;
  private lastReloadMs: number | null = null;
  private lastError: string | undefined;
  private desktopStateCache: Record<string, unknown> = {};

  constructor(private readonly opts: HotCoreSupervisorOptions) {
    this.hostNodeModulesDir = opts.hostNodeModulesDir ?? defaultNodeModulesNearEntry(opts.defaultEntryPath);
    this.slotManager = opts.slotManager ?? new HotBundleSlotManager(opts.dataDir, { hostNodeModulesDir: this.hostNodeModulesDir });
    this.boundPort = opts.port && opts.port > 0 ? opts.port : 0;
    this.token = opts.token || crypto.randomBytes(24).toString("base64url");
  }

  getStatus(): HotUpdateStatusSnapshot {
    const st = this.slotManager.getState();
    return {
      supervised: true,
      running: Boolean(this.child && this.child.exitCode === null),
      reloading: this.reloading,
      activeSlot: st.activeSlot ?? "factory",
      reloadCount: this.reloadCount,
      lastReloadMs: this.lastReloadMs,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.currentCore ? { currentCore: { ...this.currentCore } } : {}),
      slots: st,
    };
  }

  pushDesktopState(patch: Record<string, unknown>): void {
    this.desktopStateCache = { ...this.desktopStateCache, ...patch };
    this.sendChildState();
  }

  private sendChildState(): void {
    if (!this.child || this.child.exitCode !== null || !this.child.connected) return;
    try {
      this.child.send({ type: "ipc:state", state: { ...this.desktopStateCache, hotUpdateStatus: this.getStatus() } });
    } catch { /* ignore */ }
  }

  private wireChildHandlers(child: ChildProcess, onReadyMsg: (info: CoreReadyInfo) => void): void {
    child.stdout?.on("data", (buf) => this.opts.onCoreLog?.(String(buf).trimEnd()));
    child.stderr?.on("data", (buf) => this.opts.onCoreLog?.(String(buf).trimEnd()));
    child.on("message", (raw) => {
      if (!raw || typeof raw !== "object") return;
      const msg = raw as Record<string, unknown>;
      if (msg.type === "core:ready") { onReadyMsg(msg as unknown as CoreReadyInfo); return; }
      if (msg.type === "core:attention" && Array.isArray(msg.items)) { this.opts.onAttention?.(msg.items); return; }
      if (msg.type === "ipc:emit" && typeof msg.method === "string") {
        void Promise.resolve(this.opts.desktopRpcHandler?.(msg.method, Array.isArray(msg.args) ? msg.args : [])).catch(() => {});
        return;
      }
      if (msg.type === "ipc:req" && typeof msg.id === "string" && typeof msg.method === "string") {
        void Promise.resolve()
          .then(() => this.opts.desktopRpcHandler?.(msg.method as string, Array.isArray(msg.args) ? msg.args : []))
          .then((result) => child.connected && child.send({ type: "ipc:res", id: msg.id, ok: true, result }))
          .catch((err) => child.connected && child.send({ type: "ipc:res", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) }));
      }
    });
  }
  private async spawnAndVerify(): Promise<CoreReadyInfo> {
    if (!this.boundPort) this.boundPort = await allocateLoopbackPort();
    const target = this.slotManager.resolveBootTarget({ entryPath: this.opts.defaultEntryPath, uiDir: this.opts.defaultUiDir });
    const execBin = this.opts.nodeExecPath ?? process.execPath;
    const args = [...(this.opts.nodeArgs ?? []), target.entryPath];
    const timeoutMs = this.opts.healthTimeoutMs ?? 25_000;
    const env: NodeJS.ProcessEnv = {
      ...process.env, ...this.opts.extraEnv, ELECTRON_RUN_AS_NODE: "1", SUGENT_SUPERVISED_CORE: "1",
      AMB_DATA_DIR: path.resolve(this.opts.dataDir), AMB_UI_PORT: String(this.boundPort), AMB_UI_TOKEN: this.token,
      SUGENT_UI_DIR: target.uiDir, SUGENT_HOT_SLOT: target.slot, ...(target.bundleId ? { SUGENT_HOT_BUNDLE_ID: target.bundleId } : {}),
    };
    const child = spawn(execBin, args, { cwd: path.dirname(target.entryPath), env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    this.child = child;
    try {
      const info = await new Promise<CoreReadyInfo>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error(`Core startup timed out after ${timeoutMs}ms (slot=${target.slot})`));
        }, timeoutMs);
        timer.unref();
        this.wireChildHandlers(child, async (readyInfo) => {
          if (settled) return;
          try {
            const hz = await fetch(`${readyInfo.url.replace(/\/$/, "")}/amb/healthz`, { signal: AbortSignal.timeout(4000) });
            if (!hz.ok) throw new Error(`/amb/healthz returned ${hz.status}`);
            settled = true; clearTimeout(timer);
            resolve(readyInfo);
          } catch (err) {
            settled = true; clearTimeout(timer);
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
        child.once("exit", (code) => {
          if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`Core exited early with code ${code ?? "null"} (slot=${target.slot})`)); }
          else if (!this.stopping && !this.reloading && this.child === child) this.opts.onCoreExit?.(code);
        });
        child.once("error", (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } });
      });
      this.currentCore = info;
      this.boundPort = info.port || this.boundPort;
      if (target.isPending) this.slotManager.commitPendingSlot();
      this.sendChildState();
      this.opts.onCoreReady?.(info);
      return info;
    } catch (err) {
      await this.terminateChild(child);
      if (this.child === child) this.child = undefined;
      if (target.isPending) this.slotManager.rollbackPendingSlot(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private async terminateChild(child: ChildProcess | undefined): Promise<void> {
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const waitMs = this.opts.drainTimeoutMs ?? 8_000;
      let done = false;
      const finish = () => { if (!done) { done = true; clearTimeout(t1); clearTimeout(t2); resolve(); } };
      child.once("exit", finish);
      try { if (child.connected) child.send({ type: "core:drain", reason: "supervisor_swap" }); else child.kill("SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { finish(); } }
      const t1 = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* ignore */ } }, Math.min(waitMs, 4_000));
      const t2 = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } finish(); }, waitMs);
      t1.unref(); t2.unref();
    });
  }
  async start(): Promise<CoreReadyInfo> {
    this.stopping = false;
    const hadPending = Boolean(this.slotManager.getState().pendingSlot);
    try {
      return await this.spawnAndVerify();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      if (hadPending) return await this.spawnAndVerify();
      throw err;
    }
  }

  async hotReload(opts?: { reason?: string; buildCmd?: readonly string[]; cwd?: string }): Promise<{ ok: boolean; rolledBack?: boolean; activeSlot: HotBootSlot; bootId?: string; url?: string; elapsedMs: number; error?: string }> {
    if (this.reloading) return { ok: false, activeSlot: this.slotManager.getState().activeSlot ?? "factory", elapsedMs: 0, error: "HOT_RELOAD_IN_PROGRESS" };
    this.reloading = true;
    const t0 = Date.now();
    this.sendChildState();
    try {
      if (opts?.buildCmd?.length) {
        const res = await runCommand(opts.buildCmd, opts.cwd ?? path.dirname(this.opts.defaultUiDir));
        if (res.code !== 0) {
          this.lastError = `build failed: ${res.output.slice(-300)}`;
          return { ok: false, activeSlot: this.slotManager.getState().activeSlot ?? "factory", elapsedMs: Date.now() - t0, error: this.lastError };
        }
      }
      const hadPending = Boolean(this.slotManager.getState().pendingSlot);
      await this.terminateChild(this.child);
      this.child = undefined;
      try {
        const info = await this.spawnAndVerify();
        this.reloadCount += 1;
        this.lastReloadMs = Date.now() - t0;
        this.lastError = undefined;
        return { ok: true, activeSlot: info.slot, bootId: info.bootId, url: info.url, elapsedMs: this.lastReloadMs };
      } catch (spawnErr) {
        this.lastError = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
        if (hadPending) {
          const fallback = await this.spawnAndVerify();
          this.reloadCount += 1;
          this.lastReloadMs = Date.now() - t0;
          return { ok: false, rolledBack: true, activeSlot: fallback.slot, bootId: fallback.bootId, url: fallback.url, elapsedMs: this.lastReloadMs, error: this.lastError };
        }
        return { ok: false, activeSlot: this.slotManager.getState().activeSlot ?? "factory", elapsedMs: Date.now() - t0, error: this.lastError };
      }
    } finally {
      this.reloading = false;
      this.sendChildState();
    }
  }

  async stageAndHotSwapBundle(buffer: Buffer, opts?: { allowUnsigned?: boolean; trustedPublicKeys?: string[] }) {
    const staged = this.slotManager.stageBundleBuffer(buffer, opts);
    if (!staged.ok) return { ok: false, activeSlot: this.slotManager.getState().activeSlot ?? "factory", error: staged.reason ?? staged.errorCode };
    const swap = await this.hotReload({ reason: "ota_bundle_swap" });
    return { ...swap, stagedSlot: staged.slot, manifest: staged.manifest };
  }

  async rollbackSlot() {
    const rb = this.slotManager.rollbackToPrevious();
    if (!rb.ok) return { ok: false, activeSlot: rb.activeSlot ?? "factory", error: rb.reason };
    return this.hotReload({ reason: "manual_slot_rollback" });
  }

  async factoryResetSlot() {
    this.slotManager.resetToFactoryGolden();
    return this.hotReload({ reason: "factory_golden_reset" });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.terminateChild(this.child);
    this.child = undefined;
  }
}
