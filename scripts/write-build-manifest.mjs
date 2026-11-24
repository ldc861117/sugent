#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
const version = String(pkg.version || "0.0.0");

let gitHead = "nogit";
try {
  gitHead = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: rootDir, encoding: "utf8" }).trim() || "nogit";
} catch {
  gitHead = "nogit";
}

const builtAtMs = Date.now();
const builtAtIso = new Date(builtAtMs).toISOString();
const buildId = `${version}-${gitHead}-${builtAtMs.toString(36)}`;

const manifest = {
  buildId,
  version,
  gitHead,
  builtAtIso,
  builtAtMs,
  capabilityHighlights: [
    "受控读取本地已注册项目与 Antigravity brain 目录下的完整 .md/报告全文（突破 750 字截断）",
    "本地代码仓绑定、隔离 Git Worktree、双向 .sugent-handoff 文件透传与 Antigravity 两阶段定制开发流水线",
    "蓝绿防改砖安全重启看门狗与运行态版本漂移自检",
    "CLIProxyAPI 全量可用模型自动同步与经验驱动自适应选模（平衡策略 + 熔断秒切 + 质量升档）",
    "分层热启动与热更新引擎 (L0-L3)：扩展动态重载、无打包 SSE UI 瞬刷、常驻热壳 Core 热重启、Ed25519 签名 A/B 槽位热切换与秒级自动回滚",
  ],
};

const outPath = path.join(rootDir, "dist", "sugent-build-manifest.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`[build-manifest] wrote ${buildId} -> ${outPath}`);
