#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AntigravityStateReader } from "../sugent/antigravity-bridge.js";
import { AntigravityDispatcher } from "../sugent/antigravity-dispatcher.js";
import { CausalLedger } from "../sugent/causal-ledger.js";
import {
  EdgeTentacleRunner,
  scanLocalProjectsForEdge,
  type EdgeProjectPulseItem,
  type EdgeQueuedCommand,
} from "../sugent/edge-tentacle-hub.js";

export interface EdgeTentacleCliConfig {
  hubUrl: string;
  edgeToken: string;
  nodeId: string;
  projectsDirs: string[];
  intervalSec: number;
  once: boolean;
  dryRunScan: boolean;
  envFile?: string;
}

export interface EdgeTentacleRuntimeDeps {
  homeDir?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  createRunner?: (cfg: EdgeTentacleCliConfig) => {
    runOnce: () => Promise<unknown>;
    start?: () => void;
    stop?: () => void;
  };
}

function expandHome(raw: string, homeDir: string): string {
  if (raw === "~") return homeDir;
  if (raw.startsWith("~/")) return path.join(homeDir, raw.slice(2));
  return raw;
}

function loadDotEnvFile(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!filePath || !fs.existsSync(filePath)) return out;
  try {
    for (const rawLine of fs.readFileSync(filePath, "utf8").split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith("'") && val.endsWith("'") && val.length >= 2) ||
        (val.startsWith('"') && val.endsWith('"') && val.length >= 2)
      ) {
        val = val.slice(1, -1);
      }
      out[key] = val;
    }
  } catch {
    return out;
  }
  return out;
}

export function parseEdgeTentacleCliConfig(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
  homeDir = os.homedir(),
): EdgeTentacleCliConfig {
  let flagHubUrl = "";
  let flagToken = "";
  let flagNodeId = "";
  let flagInterval = "";
  let flagEnvFile = "";
  const flagProjectsDirs: string[] = [];
  let once = false;
  let dryRunScan = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--once") once = true;
    else if (arg === "--dry-run-scan") dryRunScan = true;
    else if (arg === "--hub-url" && argv[i + 1]) {
      flagHubUrl = argv[i + 1]!;
      i += 1;
    } else if (arg === "--token" && argv[i + 1]) {
      flagToken = argv[i + 1]!;
      i += 1;
    } else if (arg === "--node-id" && argv[i + 1]) {
      flagNodeId = argv[i + 1]!;
      i += 1;
    } else if (arg === "--projects-dir" && argv[i + 1]) {
      flagProjectsDirs.push(argv[i + 1]!);
      i += 1;
    } else if (arg === "--interval-sec" && argv[i + 1]) {
      flagInterval = argv[i + 1]!;
      i += 1;
    } else if (arg === "--env-file" && argv[i + 1]) {
      flagEnvFile = argv[i + 1]!;
      i += 1;
    }
  }

  const resolvedEnvFile = flagEnvFile ? expandHome(flagEnvFile, homeDir) : (env.SUGENT_ENV_FILE ? expandHome(env.SUGENT_ENV_FILE, homeDir) : undefined);
  const fileVars = resolvedEnvFile ? loadDotEnvFile(resolvedEnvFile) : {};
  const merged = (k: string): string => String(env[k] ?? fileVars[k] ?? "").trim();

  const hubUrl = (flagHubUrl || merged("SUGENT_HUB_URL")).replace(/\/+$/, "");
  const edgeToken = flagToken || merged("SUGENT_EDGE_TOKEN");
  const defaultHost = os.hostname().toLowerCase().replace(/\.local$/i, "").replace(/[^a-z0-9._-]+/g, "-") || "local-mac";
  const nodeId = flagNodeId || merged("SUGENT_NODE_ID") || defaultHost;

  const rawDirs =
    flagProjectsDirs.length > 0
      ? flagProjectsDirs
      : merged("SUGENT_PROJECTS_DIRS")
          .split(/[:,]/)
          .map((s) => s.trim())
          .filter(Boolean);
  const projectsDirs = (rawDirs.length > 0 ? rawDirs : [path.join(homeDir, "Projects")]).map((p) =>
    path.resolve(expandHome(p, homeDir)),
  );

  const parsedInterval = Number.parseInt(flagInterval || merged("SUGENT_EDGE_INTERVAL_SEC") || "45", 10);
  const intervalSec = Math.max(10, Number.isFinite(parsedInterval) ? parsedInterval : 45);

  if (!dryRunScan && (!hubUrl || !edgeToken)) {
    throw new Error("Missing SUGENT_HUB_URL or SUGENT_EDGE_TOKEN (or pass --dry-run-scan for local check).");
  }

  return {
    hubUrl,
    edgeToken,
    nodeId,
    projectsDirs,
    intervalSec,
    once,
    dryRunScan,
    ...(resolvedEnvFile ? { envFile: resolvedEnvFile } : {}),
  };
}

function resolveWorkspacePathForCommand(cmd: EdgeQueuedCommand, projectsDirs: readonly string[]): string | undefined {
  if (cmd.workspaceHint) {
    for (const root of projectsDirs) {
      const candidate = path.join(root, path.basename(cmd.workspaceHint));
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  if (cmd.projectKey) {
    const slug = cmd.projectKey.split(/[/:]/).pop();
    if (slug) {
      for (const root of projectsDirs) {
        const entries = fs.existsSync(root) ? fs.readdirSync(root) : [];
        const match = entries.find((e) => e.toLowerCase() === slug.toLowerCase());
        if (match) return path.join(root, match);
      }
    }
  }
  return projectsDirs[0];
}

export async function runEdgeTentacleMain(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
  deps: EdgeTentacleRuntimeDeps = {},
): Promise<{
  exitCode: number;
  mode: "dry-run-scan" | "once" | "daemon";
  config: EdgeTentacleCliConfig;
  projects?: EdgeProjectPulseItem[];
}> {
  const homeDir = deps.homeDir ?? os.homedir();
  const out = deps.stdout ?? ((line: string) => console.log(line));
  const cfg = parseEdgeTentacleCliConfig(argv, env, homeDir);

  const stateReader = new AntigravityStateReader({
    homeDir,
    nodeId: cfg.nodeId,
    bootstrappedAtMs: Date.now() - 48 * 3_600_000,
    cutoverHours: 48,
  });

  if (cfg.dryRunScan) {
    const scan = stateReader.scan();
    const projects = scanLocalProjectsForEdge({
      projectsRootDirs: cfg.projectsDirs,
      nodeId: cfg.nodeId,
      sessions: scan.sessions,
    });
    out(
      JSON.stringify(
        {
          ok: true,
          mode: "dry-run-scan",
          nodeId: cfg.nodeId,
          projectCount: projects.length,
          projects,
        },
        null,
        2,
      ),
    );
    return { exitCode: 0, mode: "dry-run-scan", config: cfg, projects };
  }

  const ledgerDir = path.join(homeDir, ".config", "sugent", "edge-ledger");
  const dispatcher = new AntigravityDispatcher({
    causalLedger: new CausalLedger(ledgerDir),
    sidecarsDir: path.join(homeDir, ".gemini", "config", "sidecars"),
  });

  const runner = deps.createRunner
    ? deps.createRunner(cfg)
    : new EdgeTentacleRunner({
        hubUrl: cfg.hubUrl,
        edgeToken: cfg.edgeToken,
        nodeId: cfg.nodeId,
        projectsRootDirs: cfg.projectsDirs,
        intervalMs: cfg.intervalSec * 1_000,
        scanSessions: () => stateReader.scan().sessions,
        dispatchAntigravity: async (cmd) => {
          const prompt = cmd.prompt || cmd.summary || cmd.title;
          if (cmd.action === "dispatch_antigravity_resume" && cmd.conversationId) {
            const res = await dispatcher.resumeSession({
              conversationId: cmd.conversationId,
              content: prompt,
              title: cmd.title,
            });
            return {
              ok: res.ok,
              summary: res.ok ? `已唤醒会话 ${cmd.conversationId.slice(0, 8)}` : (res.message ?? res.errorCode ?? "resume_failed"),
              conversationId: cmd.conversationId,
            };
          }
          const ws = resolveWorkspacePathForCommand(cmd, cfg.projectsDirs);
          const res = await dispatcher.startNewSession({
            prompt,
            title: cmd.title,
            ...(ws ? { workspacePath: ws } : {}),
          });
          return {
            ok: res.ok,
            summary: res.ok ? `已在 ${cfg.nodeId} 启动新会话` : (res.message ?? res.errorCode ?? "start_failed"),
            ...(res.conversationId ? { conversationId: res.conversationId } : {}),
          };
        },
      });

  if (cfg.once) {
    const res = await runner.runOnce();
    out(JSON.stringify(res));
    return { exitCode: 0, mode: "once", config: cfg };
  }

  runner.start?.();
  await new Promise<void>((resolve) => {
    const onStop = () => {
      runner.stop?.();
      process.off("SIGINT", onStop);
      process.off("SIGTERM", onStop);
      resolve();
    };
    process.on("SIGINT", onStop);
    process.on("SIGTERM", onStop);
  });
  return { exitCode: 0, mode: "daemon", config: cfg };
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]!) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  runEdgeTentacleMain(process.argv.slice(2)).catch((err) => {
    console.error(`[edge-tentacle] ${(err as Error).message}`);
    process.exit(1);
  });
}
