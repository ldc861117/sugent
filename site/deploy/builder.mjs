// 构建器主循环（容器内运行）：
//   启动时构建一次 → 每天 04:00（UTC+8）再构建一次（价格每日刷新）。
//   每次构建输出到 /srv/site/builds/<时间戳>，成功后把 /srv/site/current 这个软链接原子地换过去；失败则继续用上一版。
//   只保留最近 3 版。SITE_BUILD=draft 时用草稿构建（部署值没填齐时也能先跑起来，页面上会留着占位符）。
//   GitHub 星数另外每 2 分钟刷新一次，不用重新构建：写到 /srv/site/live/stars.json，由 nginx 以 /stars.json 提供。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fetchStars } from "../scripts/github-stars.mjs";

const OUT = process.env.SITE_OUT || "/srv/site";
const KEEP = 3;
// 没配 GITHUB_TOKEN 时匿名限额是每小时 60 次，每小时 30 次留够余量
const STARS_EVERY_MS = 2 * 60_000;
const mode = process.env.SITE_BUILD === "draft" ? "build:draft" : "build";
const log = (...a) => console.log(new Date().toISOString(), ...a);

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: "inherit", env: process.env });
    p.on("exit", (code) => resolve(code === 0));
  });
}

async function build() {
  log(`开始构建（npm run ${mode}）`);
  // 下载数据：默认读 GitHub 最新 Release（安装包由 GitHub 提供下载）；配了 DOWNLOADS_DIR 才改为读本机安装包目录
  const releases = process.env.DOWNLOADS_DIR ? "scripts/releases-from-dir.ts" : process.env.GITHUB_URL ? "scripts/releases-from-github.ts" : "";
  if (releases && !(await run("npx", ["tsx", releases]))) {
    log("生成 releases.json 失败，本次不构建");
    return;
  }
  if (!(await run("npm", ["run", mode]))) {
    log("构建失败，继续使用上一版");
    return;
  }
  const id = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "Z");
  const dir = path.join(OUT, "builds", id);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.cpSync("dist", dir, { recursive: true });
  const tmp = path.join(OUT, `current.${process.pid}`);
  fs.rmSync(tmp, { force: true });
  fs.symlinkSync(path.join("builds", id), tmp);
  fs.renameSync(tmp, path.join(OUT, "current")); // rename 覆盖旧软链接是原子的
  const old = fs.readdirSync(path.dirname(dir)).sort().slice(0, -KEEP);
  for (const o of old) fs.rmSync(path.join(path.dirname(dir), o), { recursive: true, force: true });
  log(`已上线 builds/${id}`);
}

/** 距下一个 04:00（UTC+8，即 UTC 20:00）的毫秒数 */
function untilNextRun(now = new Date()) {
  const next = new Date(now);
  next.setUTCHours(20, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next - now;
}

/** 取不到就留着上一个文件；先写临时文件再改名，nginx 不会读到写了一半的内容 */
async function refreshStars() {
  try {
    const content = JSON.stringify({ stars: await fetchStars(), fetchedAt: new Date().toISOString() }) + "\n";
    const file = path.join(OUT, "live", "stars.json");
    const tmp = `${file}.${process.pid}`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } catch (e) {
    log(`GitHub 星数未刷新（${e.message}），沿用上一个值`);
  }
}

let timer;
async function loop() {
  await build();
  const ms = untilNextRun();
  log(`下次构建在 ${Math.round(ms / 60000)} 分钟后`);
  timer = setTimeout(loop, ms);
}
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { clearTimeout(timer); process.exit(0); });
if (process.env.GITHUB_URL) {
  refreshStars();
  setInterval(refreshStars, STARS_EVERY_MS);
}
loop();
