import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

describe("electron-updater ESM compatibility", () => {
  it("supports Node ESM default import without evaluating the lazy Electron updater getter", () => {
    const entry = pathToFileURL(require.resolve("electron-updater")).href;
    const result = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import updater from ${JSON.stringify(entry)}; const descriptor = Object.getOwnPropertyDescriptor(updater, "autoUpdater"); if (typeof descriptor?.get !== "function") process.exit(1); console.log("default CJS namespace import ok");`,
      ],
      { encoding: "utf8" },
    );
    expect(result.trim()).toBe("default CJS namespace import ok");
  });
});
