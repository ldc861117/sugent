import crypto from "node:crypto";
import path from "node:path";
import { loadConfig } from "../config.js";
import { App, appVersion, type DesktopHooks, type DesktopUpdateStatus } from "../app.js";
import { logger, registerSecret } from "../log.js";
import { normalizeLang, setLangPref, setSystemLang } from "../i18n/index.js";

const log = logger("hot-core");

interface PendingRpc {
  resolve: (val: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

function createIpcBridge() {
  const pending = new Map<string, PendingRpc>();
  let cachedState: {
    autostart: { supported: boolean; on: boolean };
    updateStatus: DesktopUpdateStatus;
    companionState: { supported: boolean; visible: boolean; expanded: boolean };
    hotUpdateStatus: Record<string, unknown>;
  } = {
    autostart: { supported: false, on: false },
    updateStatus: { supported: false, state: "unsupported", currentVersion: appVersion() },
    companionState: { supported: false, visible: false, expanded: false },
    hotUpdateStatus: { supervised: Boolean(process.send) },
  };

  const callRpc = <T>(method: string, args: unknown[] = [], timeoutMs = 15_000): Promise<T> => {
    if (!process.send) return Promise.reject(new Error("IPC channel unavailable"));
    const id = `rpc-${crypto.randomBytes(4).toString("hex")}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Desktop IPC timeout for ${method}`));
      }, timeoutMs);
      timer.unref();
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      process.send!({ type: "ipc:req", id, method, args });
    });
  };

  const emit = (method: string, args: unknown[] = []) => {
    try { process.send?.({ type: "ipc:emit", method, args }); } catch { /* ignore */ }
  };

  const handleMessage = (raw: unknown): boolean => {
    if (!raw || typeof raw !== "object") return false;
    const msg = raw as Record<string, unknown>;
    if (msg.type === "ipc:state" && msg.state && typeof msg.state === "object") {
      cachedState = { ...cachedState, ...(msg.state as typeof cachedState) };
      return true;
    }
    if (msg.type === "ipc:res" && typeof msg.id === "string") {
      const hit = pending.get(msg.id);
      if (!hit) return true;
      pending.delete(msg.id);
      clearTimeout(hit.timer);
      if (msg.ok) hit.resolve(msg.result);
      else hit.reject(new Error(String(msg.error || "Desktop RPC failed")));
      return true;
    }
    return false;
  };
  return { callRpc, emit, handleMessage, getCached: () => cachedState };
}
function buildIpcDesktopHooks(ipc: ReturnType<typeof createIpcBridge>, fallbackVersion: string): DesktopHooks {
  return {
    autostart: () => ipc.getCached().autostart,
    setAutostart: (on) => ipc.emit("setAutostart", [on]),
    applyZoom: (z) => ipc.emit("applyZoom", [z]),
    setTitleBarTheme: (dark) => ipc.emit("setTitleBarTheme", [dark]),
    openDataDir: () => ipc.emit("openDataDir"),
    openPath: (p) => ipc.emit("openPath", [p]),
    showItemInFolder: (p) => ipc.emit("showItemInFolder", [p]),
    openInBrowser: () => ipc.emit("openInBrowser"),
    openExternal: (url) => ipc.emit("openExternal", [url]),
    updateStatus: () => ipc.getCached().updateStatus ?? { supported: false, state: "unsupported", currentVersion: fallbackVersion },
    downloadUpdate: () => { ipc.emit("downloadUpdate"); return ipc.getCached().updateStatus; },
    installUpdate: () => ipc.emit("installUpdate"),
    requestRelaunchQuit: () => ipc.emit("requestRelaunchQuit"),
    companionState: () => ipc.getCached().companionState,
    toggleCompanion: (v) => { ipc.emit("toggleCompanion", [v]); return ipc.getCached().companionState; },
    showCompanionQuickBar: () => { ipc.emit("showCompanionQuickBar"); return ipc.getCached().companionState; },
    notifyCompanion: (payload) => ipc.emit("notifyCompanion", [payload]),
    handoffCompanionToMain: (payload) => ipc.emit("handoffCompanionToMain", [payload]),
    hotUpdateStatus: () => ipc.getCached().hotUpdateStatus,
    requestHotReloadCore: (opts) => ipc.callRpc("requestHotReloadCore", [opts], 60_000),
    requestStageHotBundle: (bundleBase64, opts) => ipc.callRpc("requestStageHotBundle", [bundleBase64, opts], 60_000),
    requestRollbackHotSlot: () => ipc.callRpc("requestRollbackHotSlot", [], 60_000),
    requestFactoryResetHotSlot: () => ipc.callRpc("requestFactoryResetHotSlot", [], 60_000),
  };
}

export async function bootSupervisedCore(): Promise<void> {
  const dataDir = process.env.AMB_DATA_DIR ? path.resolve(process.env.AMB_DATA_DIR) : path.resolve("data");
  const config = loadConfig({ dataDir });
  config.ui.host = "127.0.0.1";
  if (process.env.AMB_UI_PORT) config.ui.port = Number(process.env.AMB_UI_PORT);
  if (process.env.AMB_UI_TOKEN) config.ui.token = process.env.AMB_UI_TOKEN;
  registerSecret(config.ui.token);
  if (process.env.SUGENT_SYSTEM_LANG) setSystemLang(normalizeLang(process.env.SUGENT_SYSTEM_LANG) ?? "zh-CN");
  setLangPref(config.ui.lang);

  const ipc = createIpcBridge();
  const app = new App(config, { fileLog: process.env.AMB_FILE_LOG !== "0" });
  if (process.send) app.desktop = buildIpcDesktopHooks(ipc, appVersion());
  let draining = false;
  const drainAndExit = async (reason = "drain") => {
    if (draining) return;
    draining = true;
    const failsafe = setTimeout(() => process.exit(1), 10_000);
    failsafe.unref();
    try { app.hotReloadBus.notifyCoreReloading(reason); } catch { /* ignore */ }
    await app.stop().catch(() => {});
    clearTimeout(failsafe);
    try { process.send?.({ type: "core:drained", pid: process.pid }); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("message", (msg) => {
    if (ipc.handleMessage(msg)) return;
    if (msg && typeof msg === "object" && (msg as { type?: string }).type === "core:drain") {
      void drainAndExit(String((msg as { reason?: string }).reason ?? "hot_reload"));
    }
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void drainAndExit(sig));
  if (process.send) app.attention.onChange((items) => { try { process.send?.({ type: "core:attention", items }); } catch { /* ignore */ } });
  await app.start();
  app.markDesktopBootHealthy(process.pid, appVersion());
  const cap = app.stewardService.getCapabilitySnapshot();
  process.send?.({
    type: "core:ready", pid: process.pid, url: app.web?.url ?? "", port: app.web?.port ?? 0, token: app.web?.token ?? config.ui.token,
    bootId: app.hotReloadBus.bootId, buildId: cap.bootBuild?.buildId ?? cap.drift.bootBuildId, version: appVersion(), slot: process.env.SUGENT_HOT_SLOT || "factory",
  });
}

const isEntry = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop()!);
if (isEntry) {
  bootSupervisedCore().catch((err) => { log.error((err as Error)?.stack || String(err)); process.exit(1); });
}
