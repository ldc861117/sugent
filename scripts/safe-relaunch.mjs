#!/usr/bin/env node
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeJsonAtomic600(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, filePath);
}

function isPidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function movePath(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err && err.code === "EXDEV") {
      fs.cpSync(src, dest, { recursive: true });
      fs.rmSync(src, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}

function readBootHealthy(dataDir) {
  const file = path.join(path.resolve(dataDir), "sugent-stewardship", "boot-healthy.json");
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof parsed?.startedAtMs === "number" ? parsed : null;
  } catch {
    return null;
  }
}

async function waitForOldPidExit(oldPid, maxWaitMs) {
  if (!oldPid || oldPid <= 0) return;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline && isPidAlive(oldPid)) {
    await sleep(80);
  }
}

function killPidBestEffort(pid) {
  if (!isPidAlive(pid)) return;
  try { process.kill(pid, "SIGTERM"); } catch { /* ignore */ }
}

async function main() {
  const txPath = process.argv[2];
  if (!txPath || !fs.existsSync(txPath)) process.exit(1);
  let tx = JSON.parse(fs.readFileSync(txPath, "utf8"));
  const updateTx = (patch) => {
    tx = { ...tx, ...patch };
    writeJsonAtomic600(txPath, tx);
  };

  await waitForOldPidExit(tx.oldPid, tx.oldPidWaitMs ?? 10_000);
  const swapStartedAtMs = Date.now();
  updateTx({ status: "swapping", swapStartedAtMs });

  let swapped = false;
  try {
    if (tx.mode === "blue_green_app" && tx.targetAppPath && tx.stagingAppPath) {
      const backupPath = tx.backupAppPath || `${tx.targetAppPath}.last-good`;
      if (fs.existsSync(backupPath)) fs.rmSync(backupPath, { recursive: true, force: true });
      if (fs.existsSync(tx.targetAppPath)) movePath(tx.targetAppPath, backupPath);
      movePath(tx.stagingAppPath, tx.targetAppPath);
      swapped = true;
    }

    let childExited = false;
    let childExitCode = null;
    const child = spawn(tx.launchCommand, tx.launchArgs || [], {
      cwd: tx.cwd || undefined,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, AMB_DATA_DIR: tx.dataDir },
    });
    child.once("exit", (code) => { childExited = true; childExitCode = code; });
    updateTx({ status: "verifying_boot", newPid: child.pid });

    const deadline = Date.now() + (tx.watchdogTimeoutMs ?? 30_000);
    const pollMs = Math.max(25, tx.pollIntervalMs ?? 150);
    let healthy = false;
    let failReason = "boot_health_timeout";

    while (Date.now() < deadline) {
      const stamp = readBootHealthy(tx.dataDir);
      if (stamp && stamp.startedAtMs >= swapStartedAtMs) {
        healthy = true;
        break;
      }
      if (childExited && (childExitCode ?? 1) !== 0) {
        failReason = `child_exited_${childExitCode}`;
        break;
      }
      await sleep(pollMs);
    }

    if (healthy) {
      child.unref();
      updateTx({ status: "succeeded", completedAtIso: new Date().toISOString() });
      process.exit(0);
    }

    killPidBestEffort(child.pid);
    await sleep(120);
    if (isPidAlive(child.pid)) {
      try { process.kill(child.pid, "SIGKILL"); } catch { /* ignore */ }
    }
    if (swapped && tx.mode === "blue_green_app") {
      const backupPath = tx.backupAppPath || `${tx.targetAppPath}.last-good`;
      if (fs.existsSync(backupPath)) {
        if (fs.existsSync(tx.targetAppPath)) fs.rmSync(tx.targetAppPath, { recursive: true, force: true });
        movePath(backupPath, tx.targetAppPath);
      }
    }
    const rbCmd = tx.rollbackCommand || tx.launchCommand;
    const rbArgs = tx.rollbackArgs || tx.launchArgs || [];
    const rbChild = spawn(rbCmd, rbArgs, {
      cwd: tx.cwd || undefined,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, AMB_DATA_DIR: tx.dataDir },
    });
    rbChild.unref();
    updateTx({ status: "rolled_back", rollbackReason: failReason, completedAtIso: new Date().toISOString() });
    process.exit(0);
  } catch (err) {
    updateTx({ status: "failed", rollbackReason: err instanceof Error ? err.message : String(err), completedAtIso: new Date().toISOString() });
    process.exit(1);
  }
}

main();
