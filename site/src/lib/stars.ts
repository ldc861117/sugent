/** 站内 /stars.json 的内容里的星数；内容不对时返回 null，页面继续用构建时的数字 */
export function parseStars(data: unknown): number | null {
  const stars = (data as { stars?: unknown } | null)?.stars;
  return Number.isInteger(stars) && (stars as number) > 0 ? (stars as number) : null;
}

// GitHub 星数的显示：1000 以内写全，往上用 k（1.2k、12k）。两种语言写法一样。
export function fmtStars(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(n / 1000)}k`;
}
