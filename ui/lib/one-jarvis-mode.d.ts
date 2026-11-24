export const LEGACY_MULTI_BOT_STORAGE_KEY: "sugent.legacyMultiBot";
export const LEGACY_MULTI_BOT_EVENT: "sugent:legacy-multibot-changed";

export function readLegacyMultiBotPref(
  storage?: { getItem?: (key: string) => string | null } | null,
): boolean;

export function writeLegacyMultiBotPref(
  storage?: { setItem?: (key: string, val: string) => void; removeItem?: (key: string) => void } | null,
  enabled?: boolean,
): void;

export function shouldShowLegacyMultiBotControls(opts?: {
  botCount?: number;
  legacyMultiBotEnabled?: boolean;
  legacyFlag?: boolean;
  modelflareConnected?: boolean;
  view?: string;
  searchQuery?: string;
}): boolean;

export function shouldShowLegacyModelflareBilling(
  account: { state?: string; balanceUsd?: number | null } | null | undefined,
): boolean;
