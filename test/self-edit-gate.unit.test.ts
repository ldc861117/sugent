import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const pluginPath = path.join(__dirname, "..", "dsh-runtime", "plugins", "amb-self-edit-gate.mjs");
const roots: string[] = [];
const previousRoot = process.env.AMB_SELF_EVOLUTION_ROOT;
const previousMode = process.env.AMB_SELF_EVOLUTION_MODE;
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-edit-gate-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "skills"), { recursive: true });
  fs.mkdirSync(path.join(root, "plugins"), { recursive: true });
  process.env.AMB_SELF_EVOLUTION_ROOT = root;
  process.env.AMB_SELF_EVOLUTION_MODE = "packaged";
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env.AMB_SELF_EVOLUTION_ROOT;
  else process.env.AMB_SELF_EVOLUTION_ROOT = previousRoot;
  if (previousMode === undefined) delete process.env.AMB_SELF_EVOLUTION_MODE;
  else process.env.AMB_SELF_EVOLUTION_MODE = previousMode;
});

describe("packaged self-evolution write gate", () => {
  it("allows extension paths and asks for other packaged workspace paths", async () => {
    const root = fixture();
    const plugin = await import(`${pluginPath}?${Math.random()}`);
    const handlers: Record<string, Function> = {};
    plugin.apply({
      on: (event: string, handler: Function) => { handlers[event] = handler; },
      get: () => ({ get: () => root }),
    });
    const next = async () => ({ kind: "allow" });
    const exec = (name: string, args: object) => ({ name, arguments: args, agent: { session: { id: "s1" } } });

    await expect(handlers["tools/pre-execute"](exec("write", { file_path: "skills/example/SKILL.md" }), next)).resolves.toEqual({ kind: "allow" });
    await expect(handlers["tools/pre-execute"](exec("edit", { file_path: "plugins/example.mjs" }), next)).resolves.toEqual({ kind: "allow" });
    await expect(handlers["tools/pre-execute"](exec("write", { file_path: "ui/index.html" }), next)).resolves.toMatchObject({ kind: "ask" });
    await expect(handlers["tools/pre-execute"](exec("write", { file_path: "../../outside.txt" }), next)).resolves.toMatchObject({ kind: "ask" });
    await expect(handlers["tools/pre-execute"](exec("write", { file_path: "plugins/../../outside.txt" }), next)).resolves.toMatchObject({ kind: "ask" });
  });

  it("uses the full-source policy when the workspace is a repository", async () => {
    const root = fixture();
    process.env.AMB_SELF_EVOLUTION_MODE = "source";
    fs.mkdirSync(path.join(root, "src", "sugent"), { recursive: true });
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    const plugin = await import(`${pluginPath}?${Math.random()}`);
    const handlers: Record<string, Function> = {};
    plugin.apply({
      on: (event: string, handler: Function) => { handlers[event] = handler; },
      get: () => ({ get: () => root }),
    });
    const next = async () => ({ kind: "allow" });
    const exec = (file_path: string) => ({ name: "write", arguments: { file_path }, agent: { session: { id: "s1" } } });

    await expect(handlers["tools/pre-execute"](exec("src/sugent/new-module.ts"), next)).resolves.toEqual({ kind: "allow" });
    await expect(handlers["tools/pre-execute"](exec("src/sugent/self-evolution.ts"), next)).resolves.toMatchObject({ kind: "ask" });
    await expect(handlers["tools/pre-execute"](exec(".git/config"), next)).resolves.toMatchObject({ kind: "deny" });
  });

  it("routes every packaged shell command through approval", async () => {
    const root = fixture();
    const plugin = await import(`${pluginPath}?${Math.random()}`);
    const handlers: Record<string, Function> = {};
    plugin.apply({
      on: (event: string, handler: Function) => { handlers[event] = handler; },
      get: () => ({ get: () => root }),
    });
    const next = async () => ({ kind: "allow" });
    await expect(
      handlers["tools/pre-execute"]({ name: "bash", arguments: { command: "echo hello" } }, next),
    ).resolves.toMatchObject({ kind: "ask" });
    await expect(
      handlers["tools/pre-execute"]({ name: "bash", arguments: { command: "mkdir plugins/new" } }, next),
    ).resolves.toMatchObject({ kind: "ask" });
    await expect(
      handlers["tools/pre-execute"]({ name: "bash", arguments: { command: "env node -e \"require('fs').writeFileSync('README_SELF_EVOLUTION.md','x')\"" } }, next),
    ).resolves.toMatchObject({ kind: "ask" });
  });
});
