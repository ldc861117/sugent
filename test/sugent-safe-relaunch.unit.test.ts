import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SafeRelaunchCoordinator, runPreflightSmokeCheck } from "../src/sugent/index.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function runWatchdog(scriptPath: string, txPath: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [scriptPath, txPath], { timeout: 10_000 }, (err, _stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? Number((err as { code: number }).code) : err ? 1 : 0;
      resolve({ code, stderr: String(stderr ?? "") });
    });
  });
}

describe("SafeRelaunchCoordinator & scripts/safe-relaunch.mjs", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  const makeTmp = (prefix: string) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(d);
    return d;
  };

  it("upgrades blue-green app bundle when new build writes boot-healthy stamp", async () => {
    const root = makeTmp("sugent-rl-ok-");
    const dataDir = path.join(root, "data");
    const targetApp = path.join(root, "Apps", "Sugent.app");
    const stagingApp = path.join(root, "Staging", "Sugent.app");
    fs.mkdirSync(targetApp, { recursive: true });
    fs.mkdirSync(stagingApp, { recursive: true });
    fs.writeFileSync(path.join(targetApp, "version.txt"), "v1");
    fs.writeFileSync(path.join(targetApp, "app.mjs"), "process.exit(0);\n");
    fs.writeFileSync(path.join(stagingApp, "version.txt"), "v2");
    fs.writeFileSync(
      path.join(stagingApp, "app.mjs"),
      [
        'import fs from "node:fs";',
        'import path from "node:path";',
        'const d = path.join(process.env.AMB_DATA_DIR, "sugent-stewardship", "boot-healthy.json");',
        'fs.mkdirSync(path.dirname(d), { recursive: true });',
        'fs.writeFileSync(d, JSON.stringify({ pid: process.pid, version: "v2", startedAtMs: Date.now(), startedAtIso: new Date().toISOString() }));',
        "setTimeout(() => process.exit(0), 120);",
      ].join("\n"),
    );

    const coord = new SafeRelaunchCoordinator({ dataDir });
    const staged = coord.stageAndTriggerRelaunch({
      pipelineId: "vp-ok",
      mode: "blue_green_app",
      targetAppPath: targetApp,
      stagingAppPath: stagingApp,
      launchCommand: process.execPath,
      launchArgs: [path.join(targetApp, "app.mjs")],
      watchdogTimeoutMs: 2500,
      pollIntervalMs: 40,
      dryRunNoSpawn: true,
    });
    const res = await runWatchdog(path.resolve(process.cwd(), "scripts", "safe-relaunch.mjs"), staged.txPath);
    expect(res.code).toBe(0);
    expect(fs.readFileSync(path.join(targetApp, "version.txt"), "utf8")).toBe("v2");
    expect(fs.readFileSync(path.join(`${targetApp}.last-good`, "version.txt"), "utf8")).toBe("v1");
    expect(coord.reconcilePostBootTransaction()?.status).toBe("succeeded");
    expect(coord.reconcilePostBootTransaction()).toBeUndefined();
  });

  it("rolls back to .last-good and relaunches v1 when new build crashes", async () => {
    const root = makeTmp("sugent-rl-rb-");
    const dataDir = path.join(root, "data");
    const targetApp = path.join(root, "Apps", "Sugent.app");
    const stagingApp = path.join(root, "Staging", "Sugent.app");
    const markerFile = path.join(root, "v1-restored.marker");
    fs.mkdirSync(targetApp, { recursive: true });
    fs.mkdirSync(stagingApp, { recursive: true });
    fs.writeFileSync(path.join(targetApp, "version.txt"), "v1");
    fs.writeFileSync(
      path.join(targetApp, "app.mjs"),
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(markerFile)}, "restored"); process.exit(0);\n`,
    );
    fs.writeFileSync(path.join(stagingApp, "version.txt"), "v2-broken");
    fs.writeFileSync(path.join(stagingApp, "app.mjs"), "process.exit(1);\n");

    const coord = new SafeRelaunchCoordinator({ dataDir });
    const staged = coord.stageAndTriggerRelaunch({
      pipelineId: "vp-rb",
      mode: "blue_green_app",
      targetAppPath: targetApp,
      stagingAppPath: stagingApp,
      launchCommand: process.execPath,
      launchArgs: [path.join(targetApp, "app.mjs")],
      watchdogTimeoutMs: 1200,
      pollIntervalMs: 35,
      dryRunNoSpawn: true,
    });
    const res = await runWatchdog(path.resolve(process.cwd(), "scripts", "safe-relaunch.mjs"), staged.txPath);
    expect(res.code).toBe(0);
    expect(fs.readFileSync(path.join(targetApp, "version.txt"), "utf8")).toBe("v1");
    expect(coord.reconcilePostBootTransaction()?.status).toBe("rolled_back");
    for (let i = 0; i < 20 && !fs.existsSync(markerFile); i++) await sleep(50);
    expect(fs.existsSync(markerFile)).toBe(true);
  });

  it("validates preflight smoke check exit code and PNG generation", async () => {
    const tmp = makeTmp("sugent-smoke-check-");
    const png = path.join(tmp, "out", "smoke.png");
    const pass = await runPreflightSmokeCheck({
      smokeArgv: [process.execPath, "-e", 'require("node:fs").writeFileSync(process.env.AMB_ELECTRON_SMOKE,"PNG")'],
      cwd: tmp,
      smokePngPath: png,
    });
    expect(pass.ok).toBe(true);
    expect(pass.smokePngPath).toBe(path.resolve(png));
    const fail = await runPreflightSmokeCheck({
      smokeArgv: [process.execPath, "-e", "process.exit(1)"],
      cwd: tmp,
      smokePngPath: path.join(tmp, "fail.png"),
    });
    expect(fail.ok).toBe(false);
  });
});