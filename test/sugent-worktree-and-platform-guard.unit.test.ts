import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LazyDesktopPermissionGate,
  allocateWorktreeIsolationEnv,
  atomicWriteCrossFs,
  inspectWorkspaceFsTopology,
  linkZeroBloatDependencies,
} from "../src/sugent/worktree-and-platform-guard.js";

describe("Wave P1.3b/P1.4 Worktree Zero-Bloat Isolation, Lazy Permissions & WSL2 Guards", () => {
  const tmpDirs: string[] = [];
  function mkTmp(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tmpDirs.length > 0) {
      fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("allocates collision-free 3-port blocks and isolated 0o700 TMPDIR across concurrent worktrees", () => {
    const root = mkTmp("sugent-wt-iso-");
    const used = new Set<number>();

    const wt1 = allocateWorktreeIsolationEnv({ worktreePath: path.join(root, "wt-1"), slotIndex: 0, usedPorts: used });
    for (const p of wt1.allocatedPorts) used.add(p);

    const wt2 = allocateWorktreeIsolationEnv({ worktreePath: path.join(root, "wt-2"), slotIndex: 0, usedPorts: used });
    expect(wt2.ports.port).not.toBe(wt1.ports.port);
    expect(fs.existsSync(wt1.tmpDir)).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(wt1.tmpDir).mode & 0o777).toBe(0o700);
    }
  });

  it("prefers macOS APFS clonefile for node_modules and safely falls back to symlink on cross-volume failure", async () => {
    const root = mkTmp("sugent-wt-link-");
    const srcRepo = path.join(root, "src-repo");
    fs.mkdirSync(path.join(srcRepo, "node_modules", "pkg-a"), { recursive: true });
    fs.writeFileSync(path.join(srcRepo, "node_modules", "pkg-a", "index.js"), "export default 1;\n");

    const wtClone = path.join(root, "wt-clone");
    const resClone = await linkZeroBloatDependencies({
      sourceRepoRoot: srcRepo,
      worktreePath: wtClone,
      platform: "darwin",
      execCloneFn: async (src, dest) => {
        fs.cpSync(src, dest, { recursive: true });
        return true;
      },
    });
    expect(resClone.linked).toBe(true);
    expect(resClone.strategy).toBe("apfs_clonefile");

    const wtFallback = path.join(root, "wt-fallback");
    const resFallback = await linkZeroBloatDependencies({
      sourceRepoRoot: srcRepo,
      worktreePath: wtFallback,
      platform: "darwin",
      execCloneFn: async () => false,
    });
    expect(resFallback.linked).toBe(true);
    expect(resFallback.strategy).toBe("symlink");
    expect(fs.lstatSync(path.join(wtFallback, "node_modules")).isSymbolicLink()).toBe(true);
  });

  it("triggers zero OS TCC probes on boot and checks/guides lazily only on first CUA action", async () => {
    let osProbes = 0;
    const gate = new LazyDesktopPermissionGate({
      defaultCheckStatusFn: (perm) => {
        osProbes += 1;
        return perm === "accessibility" ? "granted" : "denied";
      },
    });

    const boot = gate.onAppBoot();
    expect(boot.bootChecksTriggered).toBe(0);
    expect(osProbes).toBe(0);

    const check1 = await gate.ensurePermissionForCuaAction({
      required: ["screen_recording", "accessibility"],
    });
    expect(check1.allowed).toBe(false);
    expect(check1.missing).toEqual(["screen_recording"]);
    expect(check1.guideCard?.title).toContain("权限");
    expect(osProbes).toBe(2);

    const check2 = await gate.ensurePermissionForCuaAction({
      required: ["screen_recording", "accessibility"],
    });
    expect(check2.fromCache).toBe(true);
    expect(osProbes).toBe(2);
  });

  it("detects WSL2 /mnt/c slow mounts & UNC paths and self-heals EPERM/EXDEV in atomicWriteCrossFs", async () => {
    const drvfs = inspectWorkspaceFsTopology("/mnt/c/Users/alice/repo", {
      platform: "linux",
      wslDistroName: "Ubuntu-24.04",
    });
    expect(drvfs.isWslDrvFs).toBe(true);
    expect(drvfs.isSlowCrossOsMount).toBe(true);

    const unc = inspectWorkspaceFsTopology("\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\repo", {
      platform: "win32",
    });
    expect(unc.isUncWsl).toBe(true);
    expect(unc.suggestedLinuxPath).toBe("/home/alice/repo");

    const dir = mkTmp("sugent-atomic-xfs-");
    const target = path.join(dir, "state.json");
    let attempts = 0;
    const w1 = await atomicWriteCrossFs(target, '{"ok":true}\n', {
      baseBackoffMs: 1,
      renameFn: (tmp, dest) => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("locked"), { code: "EPERM" });
        }
        fs.renameSync(tmp, dest);
      },
    });
    expect(w1.strategy).toBe("retry_rename");
    expect(fs.readFileSync(target, "utf8")).toBe('{"ok":true}\n');
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);

    const w2 = await atomicWriteCrossFs(target, '{"ok":2}\n', {
      maxRetries: 1,
      baseBackoffMs: 1,
      renameFn: () => {
        throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
      },
    });
    expect(w2.strategy).toBe("fallback_overwrite");
    expect(fs.readFileSync(target, "utf8")).toBe('{"ok":2}\n');
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });
});
