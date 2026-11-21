import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafeDeliveryCommandVector } from "./delivery.js";

export interface BootHealthyStamp {
  pid: number;
  version: string;
  startedAtMs: number;
  startedAtIso: string;
}

export type RelaunchMode = "process_reload" | "blue_green_app";
export type RelaunchTxStatus = "pending" | "swapping" | "verifying_boot" | "succeeded" | "rolled_back" | "failed";

export interface RelaunchTransaction {
  txId: string;
  pipelineId: string;
  mode: RelaunchMode;
  oldPid?: number;
  targetAppPath?: string;
  stagingAppPath?: string;
  backupAppPath?: string;
  launchCommand: string;
  launchArgs: string[];
  rollbackCommand?: string;
  rollbackArgs?: string[];
  cwd?: string;
  dataDir: string;
  createdAtMs: number;
  swapStartedAtMs?: number;
  watchdogTimeoutMs: number;
  pollIntervalMs?: number;
  oldPidWaitMs?: number;
  status: RelaunchTxStatus;
  newPid?: number;
  rollbackReason?: string;
  completedAtIso?: string;
  reconciledAtIso?: string;
}

function writeJsonAtomic600(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, filePath);
}

export function getBootHealthyPath(dataDir: string): string {
  return path.join(path.resolve(dataDir), "sugent-stewardship", "boot-healthy.json");
}

export function getRelaunchTransactionPath(dataDir: string): string {
  return path.join(path.resolve(dataDir), "sugent-stewardship", "relaunch-transaction.json");
}

export function writeBootHealthyStamp(dataDir: string, info: BootHealthyStamp): string {
  const filePath = getBootHealthyPath(dataDir);
  writeJsonAtomic600(filePath, info);
  return filePath;
}

export function readBootHealthyStamp(dataDir: string): BootHealthyStamp | undefined {
  const filePath = getBootHealthyPath(dataDir);
  try {
    if (!fs.existsSync(filePath)) return undefined;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as BootHealthyStamp;
    return typeof parsed?.startedAtMs === "number" ? parsed : undefined;
  } catch {
    return undefined;
  }
}
export async function runPreflightSmokeCheck(input: {
  smokeArgv: readonly string[];
  cwd: string;
  smokePngPath: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; exitCode: number; smokePngPath?: string; outputTail: string }> {
  const safeArgv = assertSafeDeliveryCommandVector(input.smokeArgv);
  fs.mkdirSync(path.dirname(path.resolve(input.smokePngPath)), { recursive: true });
  return new Promise((resolve) => {
    execFile(
      safeArgv[0],
      safeArgv.slice(1),
      {
        cwd: path.resolve(input.cwd),
        timeout: input.timeoutMs ?? 45_000,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, AMB_ELECTRON_SMOKE: path.resolve(input.smokePngPath) },
      },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === "number" ? Number((err as { code: number }).code) : err ? 1 : 0;
        const hasPng = fs.existsSync(input.smokePngPath) && fs.statSync(input.smokePngPath).size > 0;
        const outputTail = `${stdout ?? ""}\n${stderr ?? ""}`.trim().slice(-800);
        resolve({ ok: code === 0 && hasPng, exitCode: code, ...(hasPng ? { smokePngPath: path.resolve(input.smokePngPath) } : {}), outputTail });
      },
    );
  });
}

function defaultWatchdogScriptPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "..", "..", "scripts", "safe-relaunch.mjs"),
    path.resolve(here, "..", "..", "..", "scripts", "safe-relaunch.mjs"),
    path.resolve(process.cwd(), "scripts", "safe-relaunch.mjs"),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? candidates[0]!;
}

export interface SafeRelaunchCoordinatorOptions {
  dataDir: string;
  watchdogScriptPath?: string;
  requestGracefulQuit?: () => void;
  nowMs?: () => number;
}

export interface PostBootNotice {
  txId: string;
  pipelineId: string;
  status: "succeeded" | "rolled_back" | "failed";
  summary: string;
  rollbackReason?: string;
}

export class SafeRelaunchCoordinator {
  private readonly nowMsFn: () => number;
  private readonly watchdogScript: string;

  constructor(private readonly opts: SafeRelaunchCoordinatorOptions) {
    this.nowMsFn = opts.nowMs ?? (() => Date.now());
    this.watchdogScript = opts.watchdogScriptPath ? path.resolve(opts.watchdogScriptPath) : defaultWatchdogScriptPath();
  }

  readTransaction(): RelaunchTransaction | undefined {
    const txPath = getRelaunchTransactionPath(this.opts.dataDir);
    try {
      if (!fs.existsSync(txPath)) return undefined;
      return JSON.parse(fs.readFileSync(txPath, "utf8")) as RelaunchTransaction;
    } catch {
      return undefined;
    }
  }
  stageAndTriggerRelaunch(input: {
    pipelineId: string;
    mode: RelaunchMode;
    targetAppPath?: string;
    stagingAppPath?: string;
    launchCommand: string;
    launchArgs: string[];
    rollbackCommand?: string;
    rollbackArgs?: string[];
    cwd?: string;
    oldPid?: number;
    watchdogTimeoutMs?: number;
    pollIntervalMs?: number;
    oldPidWaitMs?: number;
    dryRunNoSpawn?: boolean;
  }): { ok: boolean; txPath: string; transaction: RelaunchTransaction; error?: string } {
    if (input.mode === "blue_green_app") {
      if (!input.stagingAppPath || !fs.existsSync(path.resolve(input.stagingAppPath))) {
        throw new Error(`蓝绿替换拒绝执行：未找到预编译应用包 ${input.stagingAppPath ?? "(empty)"}`);
      }
      if (!input.targetAppPath) {
        throw new Error("蓝绿替换需要指定 targetAppPath。");
      }
    }
    const txId = `rtx-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    const targetAbs = input.targetAppPath ? path.resolve(input.targetAppPath) : undefined;
    const backupAppPath = targetAbs ? `${targetAbs}.last-good` : undefined;
    const tx: RelaunchTransaction = {
      txId,
      pipelineId: input.pipelineId,
      mode: input.mode,
      ...(input.oldPid !== undefined ? { oldPid: input.oldPid } : {}),
      ...(targetAbs ? { targetAppPath: targetAbs } : {}),
      ...(input.stagingAppPath ? { stagingAppPath: path.resolve(input.stagingAppPath) } : {}),
      ...(backupAppPath ? { backupAppPath } : {}),
      launchCommand: input.launchCommand,
      launchArgs: [...input.launchArgs],
      ...(input.rollbackCommand ? { rollbackCommand: input.rollbackCommand } : {}),
      ...(input.rollbackArgs ? { rollbackArgs: [...input.rollbackArgs] } : {}),
      ...(input.cwd ? { cwd: path.resolve(input.cwd) } : {}),
      dataDir: path.resolve(this.opts.dataDir),
      createdAtMs: this.nowMsFn(),
      watchdogTimeoutMs: input.watchdogTimeoutMs ?? 30_000,
      ...(input.pollIntervalMs !== undefined ? { pollIntervalMs: input.pollIntervalMs } : {}),
      ...(input.oldPidWaitMs !== undefined ? { oldPidWaitMs: input.oldPidWaitMs } : {}),
      status: "pending",
    };
    const txPath = getRelaunchTransactionPath(this.opts.dataDir);
    writeJsonAtomic600(txPath, tx);
    if (!input.dryRunNoSpawn) {
      const child = spawn(process.execPath, [this.watchdogScript, txPath], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      this.opts.requestGracefulQuit?.();
    }
    return { ok: true, txPath, transaction: tx };
  }

  reconcilePostBootTransaction(nowIso = new Date(this.nowMsFn()).toISOString()): PostBootNotice | undefined {
    const tx = this.readTransaction();
    if (!tx || tx.reconciledAtIso) return undefined;
    if (tx.status !== "succeeded" && tx.status !== "rolled_back" && tx.status !== "failed") return undefined;
    const updated: RelaunchTransaction = { ...tx, reconciledAtIso: nowIso };
    writeJsonAtomic600(getRelaunchTransactionPath(this.opts.dataDir), updated);
    const summary =
      tx.status === "succeeded"
        ? `版本切换与健康自检成功（事务 ${tx.txId}），新版本已稳定上线。`
        : tx.status === "rolled_back"
          ? `新版本启动健康检查未通过，看门狗已自动回滚至上一稳定版本并恢复在线（原因：${tx.rollbackReason ?? "boot_timeout"}）。`
          : `版本重启事务失败（${tx.rollbackReason ?? "unknown"}）。`;
    return {
      txId: tx.txId,
      pipelineId: tx.pipelineId,
      status: tx.status,
      summary,
      ...(tx.rollbackReason ? { rollbackReason: tx.rollbackReason } : {}),
    };
  }
}
