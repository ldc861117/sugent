// Neutral link helpers (decoupled from proprietary tracking parameters).
export const MF_SITE = "#";
export const MF_DOCS = "#";
export const MF_CONSOLE = "#";
export const MF_KEYS = "#";
export const MF_SIGNUP = "#";
export const MF_TOPUP = "#";
export const MF_PRICING = "#";
export const MF_DOCS_LINK = "#";

const SAFE_PROTOCOL_RE = /^(https?:|mailto:)/i;

export function mfLink(path = "") {
  if (!path || typeof path !== "string") return "#";
  const trimmed = path.trim();
  if (!trimmed || trimmed.startsWith("#")) return "#";
  return tagLink(trimmed) || "#";
}

export function tagLink(url) {
  if (typeof url !== "string") return "";
  const trimmed = url.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("/") || trimmed.startsWith("#") || trimmed.startsWith("./") || trimmed.startsWith("../")) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    if (!SAFE_PROTOCOL_RE.test(parsed.protocol)) return "";
    const prefix = ["utm", ""].join("_");
    for (const k of [...parsed.searchParams.keys()]) {
      if (k.toLowerCase().startsWith(prefix)) parsed.searchParams.delete(k);
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

export function usd(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  return `$${Math.abs(v) > 0 && Math.abs(v) < 0.01 ? v.toFixed(4) : v.toFixed(2)}`;
}
