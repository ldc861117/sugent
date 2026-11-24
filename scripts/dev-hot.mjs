#!/usr/bin/env node
/**
 * Developer L0-L2 Hot Runner:
 * Keeps supervisor + loopback port alive, watches src/ with tsc --incremental,
 * and hot-swaps Core on changes while ui/ hot-reloads over SSE (<300ms).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tscBin = path.join(rootDir, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
const buildArgs = ["-p", "tsconfig.build.json"];

console.log("[dev:hot] Running initial incremental TypeScript build...");
execFileSync(tscBin, buildArgs, { cwd: rootDir, stdio: "inherit" });
execFileSync(process.execPath, [path.join(rootDir, "scripts", "write-build-manifest.mjs")], { cwd: rootDir, stdio: "inherit" });

const { loadConfig, defaultDataDir } = await import("../dist/src/config.js");
const { HotCoreSupervisor } = await import("../dist/src/sugent/hot-core-supervisor.js");

const dataDir = defaultDataDir();
fs.mkdirSync(dataDir, { recursive: true });
const cfg = loadConfig({ dataDir });

const supervisor = new HotCoreSupervisor({
  dataDir,
  defaultEntryPath: path.join(rootDir, "dist", "src", "sugent", "hot-core-entry.js"),
  defaultUiDir: path.join(rootDir, "ui"),
  hostNodeModulesDir: path.join(rootDir, "node_modules"),
  ...(cfg.ui.port > 0 ? { port: cfg.ui.port } : {}),
  ...(cfg.ui.token ? { token: cfg.ui.token } : {}),
  extraEnv: { SUGENT_UI_HOT_RELOAD: "1", AMB_FILE_LOG: "1" },
  onCoreReady: (info) => {
    const login = `${info.url.replace(/\/$/, "")}/?token=${encodeURIComponent(info.token)}`;
    console.log(`[dev:hot] Core ready (pid=${info.pid}, boot=${info.bootId}, slot=${info.slot}): ${login}`);
  },
  onCoreLog: (line) => line && console.log(`[core] ${line}`),
});

await supervisor.start();

let timer = null;
const watcher = fs.watch(path.join(rootDir, "src"), { recursive: true }, (_ev, rel) => {
  if (!rel || String(rel).endsWith(".map")) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    timer = null;
    console.log(`[dev:hot] Detected change (${rel}), incremental build + L2 reload...`);
    const out = await supervisor.hotReload({ reason: `src:${rel}`, buildCmd: [tscBin, ...buildArgs], cwd: rootDir });
    console.log(`[dev:hot] Reload result: ok=${out.ok} elapsed=${out.elapsedMs}ms${out.error ? ` err=${out.error}` : ""}`);
  }, 250);
});

const shutdown = async () => {
  watcher.close();
  await supervisor.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
