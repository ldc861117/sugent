#!/usr/bin/env node
/**
 * Sugent 自举研发环境一键初始化脚本 (scripts/bootstrap-self-dev.mjs)
 *
 * 作用：
 * 1. 自动在数据目录（默认 ./data 及 macOS Electron 应用数据目录）安装 `sugent-self-dev` 固化技能；
 * 2. 将 Sugent 自身的架构拓扑、自检命令与双上游同步流程作为初始种子写入 `SugentKnowledgeGraph`；
 * 3. 输出在桌面端 App 中配置「Sugent 自演进架构师」机器人的工作区路径与人设模板。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SugentKnowledgeGraph, installSelfDevSkill } from "../dist/src/sugent/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function targetDataDirs() {
  const dirs = [path.join(repoRoot, "data")];
  if (process.platform === "darwin") {
    dirs.push(path.join(os.homedir(), "Library", "Application Support", "anymodel-bot", "data"));
    dirs.push(path.join(os.homedir(), "Library", "Application Support", "Sugent", "data"));
  }
  return dirs;
}

for (const dataDir of targetDataDirs()) {
  const skillsDir = path.join(dataDir, "dsh", "skills", "crystallized");
  const skillFile = installSelfDevSkill(skillsDir);

  const kgDir = path.join(dataDir, "knowledge-graph");
  const kg = new SugentKnowledgeGraph(kgDir);
  kg.applyDelta({
    nodes: [
      {
        id: "proj:sugent",
        kind: "project",
        name: "Sugent (Super-Agent)",
        summary: `全能个人自治智能体项目，本地源码路径：${repoRoot}`,
        tags: ["self-dev", "dsh", "electron"],
        reinforcements: 5,
      },
      {
        id: "repo:sugent-origin",
        kind: "repo",
        name: "ldc861117/sugent",
        summary: "GitHub 远端主仓库 (ssh://git@ssh.github.com:443/ldc861117/sugent.git)",
        tags: ["github", "origin"],
        reinforcements: 5,
      },
      {
        id: "wf:self-evolution-loop",
        kind: "workflow",
        name: "Sugent 自我迭代闭环流程",
        summary: "修改 src/sugent/ 代码后执行 npm run verify:sugent 门禁并推送到 GitHub",
        tags: ["self-dev", "sop"],
        reinforcements: 5,
        steps: [
          `进入源码目录 ${repoRoot} 并阅读 AGENTS.md 与 ARCHITECTURE.md`,
          "在 src/sugent/ 下编写非侵入式扩展代码，并在 scripts/verify-sugent.mjs 补充契约测试",
          "执行 npm run verify:sugent 确保 tsc 类型检查、编译构建与文档检查 0 错误",
          "执行 git commit 与 git push origin main 推送至 GitHub 远端仓库",
        ],
      },
    ],
    edges: [
      { from: "proj:sugent", relation: "hosted_at", to: "repo:sugent-origin", source: "bootstrap", exclusive: true },
      { from: "proj:sugent", relation: "evolves_via", to: "wf:self-evolution-loop", source: "bootstrap" },
    ],
  });
  kg.crystallizeSkillsToDir(skillsDir);
  console.log(`[sugent-bootstrap] 已初始化自演进知识图谱与技能: ${skillFile}`);
}

console.log(`
================================================================================
🤖 Sugent「自我迭代与代码自治」准备就绪！
================================================================================
当你打开桌面端 App (npm run electron:dev) 或 Web 控制台时，只需：
1. 将机器人的「工作区目录 (Workspace)」指向本仓库路径：
   ${repoRoot}
2. 机器人的权限保持默认「工作区可写 (Workspace)」即可（可在仓库内自由改代码、跑测试，越出本仓库目录会先问你）。
3. 机器人会自动加载已固化的 sugent-self-dev 技能与知识图谱，你可以直接在应用或微信里对它说：
   "先运行 npm run sync:upstreams 检查上游更新，再帮我在 src/sugent/ 下新增 XXX 功能并推送到 GitHub。"
================================================================================
`);
