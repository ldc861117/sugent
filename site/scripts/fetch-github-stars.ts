// 构建时取 GitHub 星数，写进 src/data/github.json：首屏 GitHub 按钮的初始值（见 sections/Hero.astro），也是 /stars.json 取不到时的备用值。
// 上线后的刷新见 deploy/builder.mjs 和 src/scripts/stars.ts。
//   GITHUB_URL     仓库地址，如 https://github.com/modelflare-ai/AnyModelBot；没配时跳过
//   GITHUB_TOKEN   可选；匿名请求一般够用
// 取不到不算构建失败：沿用文件里的上一个值，页面上只是数字旧一点。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchStars } from "./github-stars.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const file = path.join(root, "src/data/github.json");
const keep = (why: string) => console.warn(`GitHub 星数未更新（${why}），沿用上一个值`);

try {
  const stars = await fetchStars();
  fs.writeFileSync(file, JSON.stringify({ stars, fetchedAt: new Date().toISOString() }, null, 2) + "\n");
  console.log(`GitHub 星数：${stars}`);
} catch (e) {
  keep((e as Error).message);
}
