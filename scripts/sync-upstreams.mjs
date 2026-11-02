#!/usr/bin/env node
/**
 * Sugent 上游自动同步与巡检脚本 (scripts/sync-upstreams.mjs)
 *
 * 用法：
 *   node scripts/sync-upstreams.mjs --check   # 仅检查两个上游是否有新 Commit（只读，不改工作区）
 *   node scripts/sync-upstreams.mjs --merge   # 自动拉取并合并 AnyModelBot 主干 + dsh-superagent 子树
 */
import { execSync } from "node:child_process";

const UPSTREAMS = {
  amb: {
    name: "modelflare-ai/AnyModelBot",
    remote: "upstream-amb",
    url: "https://github.com/modelflare-ai/AnyModelBot.git",
    branch: "master",
    mode: "root-merge",
  },
  dsh: {
    name: "deepseek-ai/dsh-superagent-prototype",
    remote: "upstream-dsh",
    url: "https://github.com/deepseek-ai/dsh-superagent-prototype.git",
    branch: "main",
    prefix: "packages/dsh-superagent",
    mode: "subtree",
  },
};

function run(cmd, inherit = false) {
  return execSync(cmd, {
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
}

function ensureRemotes() {
  const existing = run("git remote").split(/\r?\n/).filter(Boolean);
  for (const u of Object.values(UPSTREAMS)) {
    if (!existing.includes(u.remote)) {
      console.log(`[sugent-sync] 添加远程源 ${u.remote} -> ${u.url}`);
      run(`git remote add ${u.remote} ${u.url}`);
    }
  }
}

function main() {
  const args = new Set(process.argv.slice(2));
  const isMerge = args.has("--merge");
  ensureRemotes();

  console.log("[sugent-sync] 正在获取上游最新引用...");
  for (const u of Object.values(UPSTREAMS)) {
    run(`git fetch --depth=20 ${u.remote} ${u.branch}`, true);
    const latestHash = run(`git rev-parse --short ${u.remote}/${u.branch}`).trim();
    const latestSubj = run(`git log -1 --format="%s (%cr)" ${u.remote}/${u.branch}`).trim();
    console.log(`  - ${u.name} (${u.remote}/${u.branch}): [${latestHash}] ${latestSubj}`);
  }

  if (!isMerge) {
    console.log("\n[sugent-sync] 检查完成（只读模式）。如需自动合并上游变更，请运行：npm run sync:upstreams:merge");
    return;
  }

  console.log("\n[sugent-sync] 1/2 正在合并 upstream-amb/master (AnyModelBot 宿主层)...");
  run(`git merge ${UPSTREAMS.amb.remote}/${UPSTREAMS.amb.branch} --no-edit`, true);

  console.log("\n[sugent-sync] 2/2 正在同步 upstream-dsh/main (packages/dsh-superagent 子树)...");
  run(
    `git subtree pull --prefix=${UPSTREAMS.dsh.prefix} ${UPSTREAMS.dsh.remote} ${UPSTREAMS.dsh.branch} --squash -m "chore(upstream): sync dsh-superagent-prototype"`,
    true,
  );

  console.log("\n[sugent-sync] 上游同步完成！建议立即运行: npm run typecheck && npm test");
}

main();
