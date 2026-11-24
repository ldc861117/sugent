import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { App } from "../src/app.js";
import {
  HotCoreSupervisor,
  HotReloadBus,
  createSignedHotBundle,
  generateHotBundleKeyPair,
} from "../src/sugent/index.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    await fn();
  }
});

function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("sugent hot-reload and supervisor e2e", () => {
  it("L0 reloads overlay extension manifests and busts ESM module cache", async () => {
    const root = mkTmp("sugent-l0-");
    const pluginsDir = path.join(root, "self-repo", "extensions", "plugins");
    fs.mkdirSync(pluginsDir, { recursive: true });
    const modPath = path.join(pluginsDir, "ext-alpha.mjs");
    fs.writeFileSync(modPath, "export const versionTag = 1;\n");
    fs.writeFileSync(path.join(pluginsDir, "ext-alpha.json"), JSON.stringify({ id: "sugent-ext-alpha", apiVersion: 1 }));

    const bus = new HotReloadBus({ dataDir: root, uiDir: path.join(root, "ui") });
    cleanups.push(() => bus.close());

    const r1 = bus.reloadExtensions();
    expect(r1.pluginCount).toBe(1);
    expect(r1.validIds).toEqual(["sugent-ext-alpha"]);

    const m1 = (await bus.loadHotPluginModule(modPath) as { versionTag: number }).versionTag;
    expect(m1).toBe(1);

    const future = new Date(Date.now() + 5_000);
    fs.writeFileSync(modPath, "export const versionTag = 2;\n");
    fs.utimesSync(modPath, future, future);

    const m2 = (await bus.loadHotPluginModule(modPath) as { versionTag: number }).versionTag;
    expect(m2).toBe(2);
  });

  it("L1 streams SSE core_hello + ui_change and exposes all 6 /steward/hot-update/* routes", async () => {
    const dataDir = mkTmp("sugent-l1-data-");
    const homeDir = mkTmp("sugent-l1-home-");
    const cfg = loadConfig({
      dataDir,
      env: { AMB_UI_PORT: "0", AMB_AGENT: "off", AMB_MAGPIE_BASE_URL: "http://127.0.0.1:43199/v1", AMB_WEIXIN_API_BASE: "http://127.0.0.1:9" },
    });
    const app = new App(cfg, { printQrToTerminal: false, fileLog: false, stewardHomeDir: homeDir });
    const calls: string[] = [];
    app.desktop = {
      hotUpdateStatus: () => ({ supervised: true, activeSlot: "slot-a", reloadCount: 2 }),
      requestHotReloadCore: async (o?: { reason?: string }) => { calls.push(`reload:${o?.reason ?? ""}`); return { ok: true, scheduled: true }; },
      requestStageHotBundle: async () => ({ ok: true, stagedSlot: "slot-b" }),
      requestRollbackHotSlot: async () => ({ ok: true, rolledBackTo: "slot-a" }),
      requestFactoryResetHotSlot: async () => ({ ok: true, targetSlot: "factory" }),
    } as unknown as App["desktop"];
    await app.start();
    cleanups.push(() => app.stop());

    const base = app.web!.url.replace(/\/$/, "");
    const headers = { Authorization: `Bearer ${app.web!.token}`, "Content-Type": "application/json" };
    const sseChunks: string[] = [];
    const sseReq = http.get(`${base}/amb/api/hot-reload/stream`, { headers: { Authorization: `Bearer ${app.web!.token}` } }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => sseChunks.push(String(chunk)));
    });
    cleanups.push(() => { sseReq.destroy(); });

    for (let i = 0; i < 30 && !sseChunks.join("").includes("core_hello"); i++) await new Promise((r) => setTimeout(r, 25));
    expect(sseChunks.join("")).toContain("event: core_hello");

    const rUi = await fetch(`${base}/amb/api/steward/hot-update/reload-ui`, { method: "POST", headers, body: JSON.stringify({ file: "ui/styles.css" }) });
    expect(rUi.status).toBe(200);
    for (let i = 0; i < 30 && !sseChunks.join("").includes("ui/styles.css"); i++) await new Promise((r) => setTimeout(r, 25));
    expect(sseChunks.join("")).toContain("event: ui_change");

    const st = await (await fetch(`${base}/amb/api/steward/hot-update/status`, { headers })).json();
    expect(st).toMatchObject({ supervised: true, shell: { supervised: true, activeSlot: "slot-a", reloadCount: 2 } });
    expect((await (await fetch(`${base}/amb/api/steward/hot-update/reload-core`, { method: "POST", headers, body: JSON.stringify({ reason: "t" }) })).json())).toMatchObject({ ok: true });
    expect((await (await fetch(`${base}/amb/api/steward/hot-update/stage-bundle`, { method: "POST", headers, body: JSON.stringify({}) })).json())).toMatchObject({ ok: false, error: "MISSING_BUNDLE_BASE64" });
    expect((await (await fetch(`${base}/amb/api/steward/hot-update/stage-bundle`, { method: "POST", headers, body: JSON.stringify({ bundleBase64: "YQ==" }) })).json())).toMatchObject({ ok: true, stagedSlot: "slot-b" });
    expect((await (await fetch(`${base}/amb/api/steward/hot-update/rollback`, { method: "POST", headers, body: "{}" })).json())).toMatchObject({ ok: true, rolledBackTo: "slot-a" });
    expect((await (await fetch(`${base}/amb/api/steward/hot-update/factory-reset`, { method: "POST", headers, body: "{}" })).json())).toMatchObject({ ok: true, targetSlot: "factory" });
    expect(calls).toContain("reload:t");
  });

  it("L2 hot-reloads child core on same port/token and L3 auto-rolls back on crash", async () => {
    const root = mkTmp("sugent-l2-l3-");
    const dataDir = path.join(root, "data");
    const factoryUiDir = path.join(root, "factory-ui");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(factoryUiDir, { recursive: true });
    const goodEntry = path.join(root, "good-core.mjs");
    fs.writeFileSync(
      goodEntry,
      [
        'import http from "node:http";',
        'const port = Number(process.env.AMB_UI_PORT || 0);',
        'const token = String(process.env.AMB_UI_TOKEN || "tok");',
        'const srv = http.createServer((req, res) => {',
        '  res.writeHead(200, { "content-type": "application/json" });',
        '  res.end(JSON.stringify({ ok: true, pid: process.pid, req: req.url }));',
        '});',
        'srv.listen(port, "127.0.0.1", () => {',
        '  const addr = srv.address();',
        '  const bound = typeof addr === "object" && addr ? addr.port : port;',
        '  process.send?.({ type: "core:ready", pid: process.pid, url: `http://127.0.0.1:${bound}`, port: bound, token, bootId: `b-${process.pid}`, slot: process.env.SUGENT_HOT_SLOT || "factory" });',
        '});',
        'process.on("message", (m) => {',
        '  if (m && m.type === "core:drain") srv.close(() => { process.send?.({ type: "core:drained", pid: process.pid }); process.exit(0); });',
        '});',
      ].join("\n"),
    );

    const sup = new HotCoreSupervisor({
      dataDir,
      defaultEntryPath: goodEntry,
      defaultUiDir: factoryUiDir,
      nodeExecPath: process.execPath,
      healthTimeoutMs: 8_000,
      drainTimeoutMs: 4_000,
    });
    cleanups.push(() => sup.stop());

    const r1 = await sup.start();
    expect(r1.slot).toBe("factory");
    expect((await fetch(`${r1.url}/amb/healthz`)).status).toBe(200);

    const rel = await sup.hotReload({ reason: "e2e_l2" });
    expect(rel.ok).toBe(true);
    const r2 = sup.getStatus().currentCore!;
    expect(r2.pid).not.toBe(r1.pid);
    expect(r2.port).toBe(r1.port);

    const badRoot = path.join(root, "bad-bundle-src");
    fs.mkdirSync(path.join(badRoot, "dist", "src", "sugent"), { recursive: true });
    fs.mkdirSync(path.join(badRoot, "ui"), { recursive: true });
    fs.writeFileSync(path.join(badRoot, "dist", "src", "sugent", "hot-core-entry.js"), "process.exit(42);\n");
    fs.writeFileSync(path.join(badRoot, "ui", "index.html"), "<h1>bad</h1>\n");
    const keys = generateHotBundleKeyPair();
    const pkg = createSignedHotBundle({ sourceRoot: badRoot, version: "0.9.9", privateKeyPem: keys.privateKeyPem, includePaths: ["dist", "ui"] });

    const swap = await sup.stageAndHotSwapBundle(pkg.buffer, { trustedPublicKeys: [keys.publicKeyPem] });
    expect(swap.ok).toBe(false);
    expect("rolledBack" in swap && swap.rolledBack).toBe(true);
    expect(swap.activeSlot).toBe("factory");
    expect((await fetch(`${r1.url}/amb/healthz`)).status).toBe(200);
  });
});
