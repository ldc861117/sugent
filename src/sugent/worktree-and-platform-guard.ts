import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface WorktreeAllocatedPorts {
  port: number;
  vitePort: number;
  previewPort: number;
}

export interface WorktreeIsolationEnv {
  PORT: string;
  VITE_PORT: string;
  SUGENT_PREVIEW_PORT: string;
  TMPDIR: string;
  TMP: string;
  TEMP: string;
}

export interface WorktreeIsolationEnvResult {
  worktreePath: string;
  tmpDir: string;
  slotIndex: number;
  ports: WorktreeAllocatedPorts;
  allocatedPorts: [number, number, number];
  env: WorktreeIsolationEnv;
}

export function allocateWorktreeIsolationEnv(input: {
  worktreePath: string;
  slotIndex?: number;
  usedPorts?: ReadonlySet<number>;
  basePort?: number;
}): WorktreeIsolationEnvResult {
  const resolved = path.resolve(input.worktreePath.trim());
  const basePort = input.basePort ?? 4100;
  const stride = 10;
  const maxSlots = Math.floor((65530 - basePort) / stride) + 1;
  const initialSlot =
    input.slotIndex !== undefined
      ? Math.max(0, input.slotIndex % maxSlots)
      : createHash("sha256").update(resolved).digest().readUInt32BE(0) % 1000;

  let chosenSlot = initialSlot;
  let chosenBase = basePort + initialSlot * stride;
  for (let step = 0; step < maxSlots; step += 1) {
    const slot = (initialSlot + step) % maxSlots;
    const p = basePort + slot * stride;
    if (!input.usedPorts?.has(p) && !input.usedPorts?.has(p + 1) && !input.usedPorts?.has(p + 2)) {
      chosenSlot = slot;
      chosenBase = p;
      break;
    }
  }

  const tmpDir = path.join(resolved, ".sugent-tmp");
  fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(tmpDir, 0o700);
    } catch {
      // ignore non-posix fs
    }
  }

  const ports: WorktreeAllocatedPorts = {
    port: chosenBase,
    vitePort: chosenBase + 1,
    previewPort: chosenBase + 2,
  };
  return {
    worktreePath: resolved,
    tmpDir,
    slotIndex: chosenSlot,
    ports,
    allocatedPorts: [ports.port, ports.vitePort, ports.previewPort],
    env: {
      PORT: String(ports.port),
      VITE_PORT: String(ports.vitePort),
      SUGENT_PREVIEW_PORT: String(ports.previewPort),
      TMPDIR: tmpDir,
      TMP: tmpDir,
      TEMP: tmpDir,
    },
  };
}

export type ZeroBloatLinkStrategy =
  | "apfs_clonefile"
  | "junction"
  | "symlink"
  | "skipped_missing"
  | "skipped_exists";

function defaultApfsClone(src: string, dest: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("cp", ["-c", "-R", src, dest], (err) => {
      if (err) {
        try {
          fs.rmSync(dest, { recursive: true, force: true });
        } catch {
          // ignore
        }
        resolve(false);
        return;
      }
      resolve(fs.existsSync(dest));
    });
  });
}

function lstatExists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export async function linkZeroBloatDependencies(input: {
  sourceRepoRoot: string;
  worktreePath: string;
  platform?: NodeJS.Platform;
  execCloneFn?: (src: string, dest: string) => Promise<boolean>;
}): Promise<{
  linked: boolean;
  strategy: ZeroBloatLinkStrategy;
  sourceNodeModules: string;
  targetNodeModules: string;
}> {
  const srcNm = path.join(path.resolve(input.sourceRepoRoot), "node_modules");
  const wtRoot = path.resolve(input.worktreePath);
  const destNm = path.join(wtRoot, "node_modules");

  if (!fs.existsSync(srcNm)) {
    return { linked: false, strategy: "skipped_missing", sourceNodeModules: srcNm, targetNodeModules: destNm };
  }
  if (lstatExists(destNm)) {
    return { linked: false, strategy: "skipped_exists", sourceNodeModules: srcNm, targetNodeModules: destNm };
  }
  await fs.promises.mkdir(wtRoot, { recursive: true });
  const plat = input.platform ?? process.platform;

  if (plat === "darwin") {
    const cloneFn = input.execCloneFn ?? defaultApfsClone;
    let ok = false;
    try {
      ok = await cloneFn(srcNm, destNm);
    } catch {
      ok = false;
    }
    if (ok) {
      return { linked: true, strategy: "apfs_clonefile", sourceNodeModules: srcNm, targetNodeModules: destNm };
    }
    if (lstatExists(destNm)) {
      await fs.promises.rm(destNm, { recursive: true, force: true });
    }
  }

  if (plat === "win32") {
    await fs.promises.symlink(srcNm, destNm, "junction");
    return { linked: true, strategy: "junction", sourceNodeModules: srcNm, targetNodeModules: destNm };
  }
  await fs.promises.symlink(srcNm, destNm, "dir");
  return { linked: true, strategy: "symlink", sourceNodeModules: srcNm, targetNodeModules: destNm };
}

export type DesktopPermissionKind = "screen_recording" | "accessibility";
export type DesktopPermissionStatus = "granted" | "denied" | "not_determined";

export interface PermissionGuideCard {
  title: string;
  summary: string;
  missingPermissions: DesktopPermissionKind[];
  steps: string[];
}

export class LazyDesktopPermissionGate {
  private readonly cache = new Map<DesktopPermissionKind, DesktopPermissionStatus>();
  private runtimeChecks = 0;

  constructor(
    private readonly opts: {
      defaultCheckStatusFn?: (
        perm: DesktopPermissionKind,
      ) => DesktopPermissionStatus | Promise<DesktopPermissionStatus>;
    } = {},
  ) {}

  onAppBoot() {
    // Strictly zero macOS TCC probes on startup to eliminate installation panic
    return {
      booted: true as const,
      bootChecksTriggered: 0 as const,
      deferredPermissions: ["screen_recording", "accessibility"] as DesktopPermissionKind[],
    };
  }

  get runtimeChecksTriggered(): number {
    return this.runtimeChecks;
  }

  clearSessionCache(): void {
    this.cache.clear();
  }

  async ensurePermissionForCuaAction(input: {
    required: readonly DesktopPermissionKind[];
    forceRefresh?: boolean;
    checkStatusFn?: (perm: DesktopPermissionKind) => DesktopPermissionStatus | Promise<DesktopPermissionStatus>;
  }) {
    const statuses: Partial<Record<DesktopPermissionKind, DesktopPermissionStatus>> = {};
    let fromCache = true;
    const checkFn = input.checkStatusFn ?? this.opts.defaultCheckStatusFn;

    for (const perm of Array.from(new Set(input.required))) {
      const hit = !input.forceRefresh ? this.cache.get(perm) : undefined;
      if (hit !== undefined) {
        statuses[perm] = hit;
        continue;
      }
      fromCache = false;
      this.runtimeChecks += 1;
      let st: DesktopPermissionStatus = "not_determined";
      if (checkFn) {
        try {
          st = await checkFn(perm);
        } catch {
          st = "denied";
        }
      }
      this.cache.set(perm, st);
      statuses[perm] = st;
    }

    const missing = Array.from(new Set(input.required)).filter((p) => statuses[p] !== "granted");
    if (missing.length === 0) {
      return { allowed: true, statuses, missing: [] as DesktopPermissionKind[], guideCard: null, fromCache };
    }
    const labels = missing.map((m) => (m === "screen_recording" ? "屏幕录制" : "辅助功能")).join("、");
    const guideCard: PermissionGuideCard = {
      title: "需要开启桌面操控权限以继续",
      summary: `Sugent 安装启动时不预索取隐私权限；当前桌面任务需要开启「${labels}」后才能继续。`,
      missingPermissions: missing,
      steps: [
        "打开系统设置 -> 隐私与安全性",
        `在「${labels}」列表中勾选启用 Sugent`,
        "返回当前对话重试指令即可生效",
      ],
    };
    return { allowed: false, statuses, missing, guideCard, fromCache };
  }
}

export function inspectWorkspaceFsTopology(
  rawPath: string,
  opts?: { platform?: NodeJS.Platform; wslDistroName?: string },
) {
  const trimmed = rawPath.trim();
  const unc = /^(?:\\\\|\/\/)(wsl\.localhost|wsl\$)[\\/]([^\\/]+)(?:[\\/](.*))?$/i.exec(trimmed);
  if (unc) {
    const distro = unc[2] ?? "WSL";
    const sub = (unc[3] ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const suggestedLinuxPath = sub ? `/${sub}` : "/";
    return {
      rawPath,
      normalizedPath: `\\\\wsl.localhost\\${distro}${sub ? `\\${sub.replace(/\//g, "\\")}` : ""}`,
      kind: "windows_unc_wsl" as const,
      isUncWsl: true,
      isWslDrvFs: false,
      isSlowCrossOsMount: true,
      wslDistroName: distro,
      suggestedLinuxPath,
      migrationAdvice: `建议直接在 WSL2 (${distro}) 内部原生路径 ${suggestedLinuxPath} 执行开发任务以避免 9P 跨内核损耗。`,
    };
  }

  const winDrive = /^([a-zA-Z]):(?:[\\/](.*))?$/.exec(trimmed);
  if (winDrive) {
    const drv = (winDrive[1] ?? "C").toUpperCase();
    const rest = (winDrive[2] ?? "").replace(/\//g, "\\");
    return {
      rawPath,
      normalizedPath: `${drv}:\\${rest}`,
      kind: "native_ntfs" as const,
      isUncWsl: false,
      isWslDrvFs: false,
      isSlowCrossOsMount: false,
    };
  }

  const plat = opts?.platform ?? process.platform;
  const norm = path.posix.normalize(trimmed.replace(/\\/g, "/"));
  const drvfs = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(norm);
  if (drvfs && plat !== "win32") {
    const leaf = path.posix.basename(drvfs[2] ?? "repo");
    return {
      rawPath,
      normalizedPath: norm,
      kind: "wsl_drvfs_mount" as const,
      isUncWsl: false,
      isWslDrvFs: true,
      isSlowCrossOsMount: true,
      suggestedLinuxPath: `~/projects/${leaf}`,
      migrationAdvice: `检测到 WSL2 跨内核慢速挂载点 ${norm}，建议迁回 WSL2 原生 ext4 目录（如 ~/projects/${leaf}）。`,
    };
  }

  return {
    rawPath,
    normalizedPath: norm,
    kind: plat === "darwin" ? ("native_macos" as const) : ("native_linux" as const),
    isUncWsl: false,
    isWslDrvFs: false,
    isSlowCrossOsMount: false,
  };
}

export async function atomicWriteCrossFs(
  filePath: string,
  content: string | Buffer,
  opts?: {
    mode?: number;
    maxRetries?: number;
    baseBackoffMs?: number;
    renameFn?: (tmp: string, dest: string) => void | Promise<void>;
  },
): Promise<{
  filePath: string;
  bytesWritten: number;
  attempts: number;
  strategy: "atomic_rename" | "retry_rename" | "fallback_overwrite";
}> {
  const dest = path.resolve(filePath);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  const maxRetries = Math.max(0, opts?.maxRetries ?? 4);
  const backoff = Math.max(1, opts?.baseBackoffMs ?? 12);
  const renameImpl = opts?.renameFn ?? ((t: string, d: string) => fs.promises.rename(t, d));
  const tmp = `${dest}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;

  await fs.promises.writeFile(tmp, buf, opts?.mode !== undefined ? { mode: opts.mode } : undefined);
  let attempts = 0;

  try {
    while (true) {
      attempts += 1;
      try {
        await renameImpl(tmp, dest);
        return {
          filePath: dest,
          bytesWritten: buf.byteLength,
          attempts,
          strategy: attempts === 1 ? "atomic_rename" : "retry_rename",
        };
      } catch (err) {
        const code = typeof err === "object" && err && "code" in err ? String((err as { code?: unknown }).code) : "";
        const isTransientLock = code === "EPERM" || code === "EACCES" || code === "EBUSY";
        if (code === "EXDEV" || (isTransientLock && attempts > maxRetries)) {
          await fs.promises.writeFile(dest, buf, opts?.mode !== undefined ? { mode: opts.mode } : undefined);
          return {
            filePath: dest,
            bytesWritten: buf.byteLength,
            attempts,
            strategy: "fallback_overwrite",
          };
        }
        if (isTransientLock) {
          await new Promise((r) => setTimeout(r, backoff * attempts));
          continue;
        }
        throw err;
      }
    }
  } finally {
    if (fs.existsSync(tmp)) {
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
    }
  }
}
