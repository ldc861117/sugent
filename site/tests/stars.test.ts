import { describe, expect, it } from "vitest";
import { fmtStars, parseStars } from "../src/lib/stars";

describe("fmtStars", () => {
  it.each([
    [0, "0"], [141, "141"], [999, "999"],
    [1000, "1k"], [1234, "1.2k"], [9950, "9.9k"], [9999, "10k"],
    [12345, "12k"], [128600, "129k"],
  ])("%i → %s", (n, text) => expect(fmtStars(n)).toBe(text));
});

describe("parseStars", () => {
  it("取出星数", () => expect(parseStars({ stars: 745, fetchedAt: "2026-11-02T00:00:00Z" })).toBe(745));
  it.each([[null], [{}], [{ stars: "745" }], [{ stars: 1.5 }], [{ stars: -1 }], [{ stars: 0 }]])("内容不对：%j", (data) =>
    expect(parseStars(data)).toBeNull(),
  );
});
