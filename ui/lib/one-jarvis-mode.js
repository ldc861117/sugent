// One-Jarvis 唯一幕僚前台收敛判定与兼容存储工具（纯原生浏览器 ESM + JSDoc，供 Node 单测与 UI 视图共用）

export const LEGACY_MULTI_BOT_STORAGE_KEY = "sugent.legacyMultiBot";
export const LEGACY_MULTI_BOT_EVENT = "sugent:legacy-multibot-changed";

function defaultStorage() {
  try {
    return typeof globalThis !== "undefined" && "localStorage" in globalThis ? globalThis.localStorage : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {{ getItem?: (key: string) => string | null } | null | undefined} [storage]
 * @returns {boolean}
 */
export function readLegacyMultiBotPref(storage = defaultStorage()) {
  try {
    if (!storage || typeof storage.getItem !== "function") return false;
    return storage.getItem(LEGACY_MULTI_BOT_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * @param {{ setItem?: (key: string, val: string) => void; removeItem?: (key: string) => void } | null | undefined} [storage]
 * @param {boolean} [enabled]
 */
export function writeLegacyMultiBotPref(storage = defaultStorage(), enabled = false) {
  try {
    const target = storage ?? defaultStorage();
    if (target) {
      if (enabled && typeof target.setItem === "function") {
        target.setItem(LEGACY_MULTI_BOT_STORAGE_KEY, "1");
      } else if (!enabled && typeof target.removeItem === "function") {
        target.removeItem(LEGACY_MULTI_BOT_STORAGE_KEY);
      }
    }
    if (typeof globalThis !== "undefined" && typeof globalThis.dispatchEvent === "function" && typeof Event === "function") {
      globalThis.dispatchEvent(new Event(LEGACY_MULTI_BOT_EVENT));
    }
  } catch {
    // ignore storage quota or private mode errors
  }
}

/**
 * @param {{
 *   botCount?: number;
 *   legacyMultiBotEnabled?: boolean;
 *   legacyFlag?: boolean;
 *   modelflareConnected?: boolean;
 *   view?: string;
 *   searchQuery?: string;
 * }} [opts]
 * @returns {boolean}
 */
export function shouldShowLegacyMultiBotControls(opts = {}) {
  if (opts.legacyMultiBotEnabled || opts.legacyFlag || opts.modelflareConnected) return true;
  if ((opts.botCount ?? 0) > 1) return true;
  if (opts.view === "new" || opts.view === "bot-settings") return true;
  if (typeof opts.searchQuery === "string" && opts.searchQuery.trim().length > 0) return true;
  return false;
}

/**
 * @param {{ state?: string; balanceUsd?: number | null } | null | undefined} account
 * @returns {boolean}
 */
export function shouldShowLegacyModelflareBilling(account) {
  if (!account || account.state !== "signed_in") return false;
  return typeof account.balanceUsd === "number" && Number.isFinite(account.balanceUsd);
}
