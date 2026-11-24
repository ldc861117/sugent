import { describe, expect, it } from "vitest";
import {
  LEGACY_MULTI_BOT_STORAGE_KEY,
  readLegacyMultiBotPref,
  shouldShowLegacyModelflareBilling,
  shouldShowLegacyMultiBotControls,
  writeLegacyMultiBotPref,
} from "../ui/lib/one-jarvis-mode.js";

describe("One-Jarvis Single-Steward UI Default Mode & Legacy Fold", () => {
  it("hides multi-bot creation and specialist list noise by default for single-bot users", () => {
    expect(
      shouldShowLegacyMultiBotControls({
        botCount: 1,
        legacyMultiBotEnabled: false,
        view: "steward",
        searchQuery: "",
      }),
    ).toBe(false);

    expect(shouldShowLegacyMultiBotControls({ botCount: 2, legacyMultiBotEnabled: false, view: "chat" })).toBe(true);
    expect(shouldShowLegacyMultiBotControls({ botCount: 1, legacyMultiBotEnabled: true, view: "chat" })).toBe(true);
    expect(shouldShowLegacyMultiBotControls({ botCount: 1, legacyMultiBotEnabled: false, view: "new" })).toBe(true);
  });

  it("hides legacy Modelflare billing top-up UI unless legacy Modelflare account is actively signed in", () => {
    expect(shouldShowLegacyModelflareBilling(null)).toBe(false);
    expect(shouldShowLegacyModelflareBilling({ state: "signed_out", balanceUsd: 0 })).toBe(false);
    expect(shouldShowLegacyModelflareBilling({ state: "signed_in", balanceUsd: null })).toBe(false);
    expect(shouldShowLegacyModelflareBilling({ state: "signed_in", balanceUsd: 12.5 })).toBe(true);
  });

  it("reads and writes legacy multi-bot preference safely with or without localStorage", () => {
    expect(readLegacyMultiBotPref(undefined)).toBe(false);
    const mem = new Map<string, string>();
    const mockStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => { mem.set(k, v); },
      removeItem: (k: string) => { mem.delete(k); },
    };
    writeLegacyMultiBotPref(mockStorage, true);
    expect(mem.get(LEGACY_MULTI_BOT_STORAGE_KEY)).toBe("1");
    expect(readLegacyMultiBotPref(mockStorage)).toBe(true);

    writeLegacyMultiBotPref(mockStorage, false);
    expect(readLegacyMultiBotPref(mockStorage)).toBe(false);
  });
});
