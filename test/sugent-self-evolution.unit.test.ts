import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SUGENT_PLUGIN_API_VERSION,
  assessSelfEditPath,
  ensureSelfEvolutionOverlay,
  getOverlayRepoDir,
  inspectSelfEvolutionPlugins,
  resolveOverlayUiFile,
} from "../src/sugent/self-evolution.js";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-self-evolution-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Sugent packaged self-evolution boundaries", () => {
  it("archives legacy UI overlays and always resolves the builtin UI", () => {
    const dataDir = tempDir();
    const overlayDir = path.join(dataDir, "self-repo");
    fs.mkdirSync(path.join(overlayDir, "ui"), { recursive: true });
    fs.writeFileSync(path.join(overlayDir, "ui", "index.html"), "legacy");
    const builtinDir = path.join(dataDir, "builtin-ui");
    fs.mkdirSync(builtinDir);
    fs.writeFileSync(path.join(builtinDir, "index.html"), "official");

    ensureSelfEvolutionOverlay(dataDir, path.join(dataDir, "Sugent.app.asar"));

    expect(resolveOverlayUiFile(dataDir, builtinDir, "index.html")).toBe(path.join(builtinDir, "index.html"));
    expect(fs.existsSync(path.join(overlayDir, "UI_OVERLAY_DISABLED.md"))).toBe(true);
    expect(fs.readdirSync(dataDir).some((name) => name.startsWith("self-repo-ui.backup-"))).toBe(true);
  });

  it("only exposes plugins with a valid compatible sidecar", () => {
    const dataDir = tempDir();
    const pluginsDir = path.join(dataDir, "self-repo", "extensions", "plugins");
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, "valid.mjs"), "export default {};");
    fs.writeFileSync(
      path.join(pluginsDir, "valid.json"),
      JSON.stringify({ id: "sugent-ext-valid", apiVersion: SUGENT_PLUGIN_API_VERSION }),
    );
    fs.writeFileSync(path.join(pluginsDir, "legacy.mjs"), "export default {};");
    fs.writeFileSync(path.join(pluginsDir, "wrong.mjs"), "export default {};");
    fs.writeFileSync(path.join(pluginsDir, "wrong.json"), JSON.stringify({ id: "official", apiVersion: 99 }));
    fs.writeFileSync(path.join(pluginsDir, "malformed.mjs"), "export default {};");
    fs.writeFileSync(path.join(pluginsDir, "malformed.mjs.json"), "{");
    fs.writeFileSync(path.join(pluginsDir, "dup-a.mjs"), "export default {};");
    fs.writeFileSync(path.join(pluginsDir, "dup-a.mjs.json"), JSON.stringify({ id: "sugent-ext-duplicate", apiVersion: SUGENT_PLUGIN_API_VERSION }));
    fs.writeFileSync(path.join(pluginsDir, "dup-b.mjs"), "export default {};");
    fs.writeFileSync(path.join(pluginsDir, "dup-b.mjs.json"), JSON.stringify({ id: "sugent-ext-duplicate", apiVersion: SUGENT_PLUGIN_API_VERSION }));

    const report = inspectSelfEvolutionPlugins(dataDir);
    expect(report.plugins.map((plugin) => plugin.id)).toEqual(["sugent-ext-valid"]);
    // Missing manifest, invalid id/API, malformed JSON, and both members of the
    // duplicate-id group are reported individually so every skipped file is visible.
    expect(report.issues).toHaveLength(5);
  });

  it("migrates legacy extensions without overwriting conflicts and removes source-repo links", () => {
    const dataDir = tempDir();
    const rootDir = path.join(dataDir, "self-repo");
    const legacyPlugins = path.join(rootDir, "plugins");
    const legacySkills = path.join(rootDir, "skills");
    fs.mkdirSync(legacyPlugins, { recursive: true });
    fs.mkdirSync(legacySkills, { recursive: true });
    fs.writeFileSync(path.join(legacyPlugins, "legacy.mjs"), "export default {};");
    fs.writeFileSync(path.join(legacySkills, "legacy.txt"), "keep me");
    const extPlugins = path.join(rootDir, "extensions", "plugins");
    fs.mkdirSync(extPlugins, { recursive: true });
    fs.writeFileSync(path.join(extPlugins, "legacy.mjs"), "new copy");
    const sourceRepo = path.join(dataDir, "source-repo-target");
    fs.mkdirSync(sourceRepo);
    fs.symlinkSync(sourceRepo, path.join(rootDir, "source-repo"), "dir");

    ensureSelfEvolutionOverlay(dataDir, path.join(dataDir, "Sugent.app.asar"));

    expect(fs.readFileSync(path.join(extPlugins, "legacy.mjs"), "utf8")).toBe("new copy");
    expect(fs.readdirSync(rootDir).some((name) => name.startsWith("legacy-plugins-"))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, "extensions", "skills", "legacy.txt"))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, "source-repo"))).toBe(false);
    expect(getOverlayRepoDir(dataDir)).toBe(path.join(rootDir, "extensions"));
  });

  it("uses separate edit policy for packaged and source workspaces", () => {
    expect(assessSelfEditPath("skills/example/SKILL.md", "packaged").risk).toBe("autonomous");
    expect(assessSelfEditPath("plugins/example.mjs", "packaged").risk).toBe("autonomous");
    expect(assessSelfEditPath("ui/index.html", "packaged").risk).toBe("requires_approval");
    expect(assessSelfEditPath("src/sugent/kernel.ts", "source").risk).toBe("autonomous");
    expect(assessSelfEditPath("skills/../../src/sugent/kernel.ts", "packaged").risk).toBe("requires_approval");
    expect(assessSelfEditPath("C:\\Users\\agent\\secret.txt", "packaged").risk).toBe("requires_approval");
    expect(assessSelfEditPath("plugins/nested/example.mjs", "packaged").risk).toBe("autonomous");
  });
});
