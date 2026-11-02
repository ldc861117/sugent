// 向 GitHub 取星数，失败时抛错。构建（scripts/fetch-github-stars.ts）和线上的定时刷新（deploy/builder.mjs）共用。
//   GITHUB_URL     仓库地址，如 https://github.com/modelflare-ai/AnyModelBot
//   GITHUB_TOKEN   可选；匿名每小时 60 次，够用
export async function fetchStars() {
  const m = /github\.com\/([^/]+)\/([^/.]+)/.exec(process.env.GITHUB_URL || "");
  if (!m) throw new Error("GITHUB_URL 不是 GitHub 仓库地址");
  const headers = { accept: "application/vnd.github+json", "user-agent": "anymodelbot-site" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}`, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const stars = (await res.json()).stargazers_count;
  if (!Number.isInteger(stars) || stars < 0) throw new Error(`返回的星数不对：${stars}`);
  return stars;
}
