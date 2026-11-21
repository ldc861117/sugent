import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SugentKnowledgeGraph } from "./knowledge-graph.js";

export interface CapabilityDescriptor {
  toolName: string;
  title: string;
  summary: string;
  whenToUse: string[];
  addedIn?: string;
}

export interface BuildManifest {
  buildId: string;
  version: string;
  gitHead: string;
  builtAtIso: string;
  builtAtMs: number;
  capabilityHighlights: string[];
}

export interface RuntimeDriftStatus {
  bootBuildId?: string;
  diskBuildId?: string;
  drifted: boolean;
  diskBuiltAtIso?: string;
  summary: string;
}

export interface InstalledSkillSummary {
  name: string;
  description: string;
  filePath: string;
}

export interface EvolutionRecord {
  buildId: string;
  version: string;
  recordedAtIso: string;
  highlights: string[];
}

export interface CapabilityAwarenessSnapshot {
  bootBuild?: BuildManifest;
  drift: RuntimeDriftStatus;
  tools: CapabilityDescriptor[];
  installedSkills: InstalledSkillSummary[];
  recentEvolutions: EvolutionRecord[];
  readableProjectCount: number;
}

function writeJsonAtomic600(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, filePath);
}
export function readBuildManifest(explicitPath?: string): BuildManifest | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = explicitPath
    ? [path.resolve(explicitPath)]
    : [
        path.resolve(here, "..", "..", "sugent-build-manifest.json"),
        path.resolve(here, "..", "..", "..", "dist", "sugent-build-manifest.json"),
        path.resolve(process.cwd(), "dist", "sugent-build-manifest.json"),
      ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<BuildManifest>;
      if (typeof parsed?.buildId === "string" && parsed.buildId.trim()) {
        return {
          buildId: parsed.buildId.trim(),
          version: String(parsed.version ?? "0.0.0"),
          gitHead: String(parsed.gitHead ?? "nogit"),
          builtAtIso: String(parsed.builtAtIso ?? ""),
          builtAtMs: Number(parsed.builtAtMs ?? 0),
          capabilityHighlights: Array.isArray(parsed.capabilityHighlights) ? parsed.capabilityHighlights.map(String) : [],
        };
      }
    } catch {
      // ignore corrupted build manifest
    }
  }
  return undefined;
}

function parseSkillFrontmatter(skillFile: string, fallbackName: string): InstalledSkillSummary | undefined {
  try {
    const raw = fs.readFileSync(skillFile, "utf8");
    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    let name = fallbackName;
    let description = "";
    if (fm?.[1]) {
      const nMatch = fm[1].match(/^\s*name:\s*["']?(.+?)["']?\s*$/m);
      const dMatch = fm[1].match(/^\s*description:\s*["']?(.+?)["']?\s*$/m);
      if (nMatch?.[1]) name = nMatch[1].trim();
      if (dMatch?.[1]) description = dMatch[1].trim();
    }
    if (!description) {
      const bodyLine = raw.replace(/^---[\s\S]*?---/, "").split(/\r?\n/).find((l) => l.trim() && !l.startsWith("#"));
      description = bodyLine ? bodyLine.trim().slice(0, 140) : "已安装技能";
    }
    return { name, description, filePath: skillFile };
  } catch {
    return undefined;
  }
}

export function scanInstalledSkills(dataDir: string, workspaceRoot?: string): InstalledSkillSummary[] {
  const dirs = [
    path.join(path.resolve(dataDir), "self-repo", "extensions", "skills"),
    path.join(path.resolve(dataDir), "dsh", "default", "skills"),
    ...(workspaceRoot ? [path.join(path.resolve(workspaceRoot), "skills")] : []),
  ];
  const seen = new Map<string, InstalledSkillSummary>();
  for (const base of dirs) {
    if (!fs.existsSync(base)) continue;
    try {
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillFile = path.join(base, entry.name, "SKILL.md");
        if (!fs.existsSync(skillFile)) continue;
        const parsed = parseSkillFrontmatter(skillFile, entry.name);
        if (parsed && !seen.has(parsed.name)) seen.set(parsed.name, parsed);
      }
    } catch {
      // ignore unreadable skill root
    }
  }
  return Array.from(seen.values());
}
export function formatCapabilityAwarenessPrompt(
  snap: CapabilityAwarenessSnapshot,
  boundRepos: readonly { alias: string; repoRoot: string }[] = [],
): string {
  const lines: string[] = [];
  if (snap.drift.drifted) {
    lines.push(
      `【重要：运行态版本漂移提示】${snap.drift.summary} 若主人询问刚刚新增的能力为何不可用或要求使用新能力，请坦诚说明当前服务尚未重启加载最新编译产物，并建议重启工作台生效。`,
    );
  } else if (snap.bootBuild) {
    lines.push(`当前运行构建：${snap.bootBuild.buildId}（编译于 ${snap.bootBuild.builtAtIso}）`);
  }
  if (snap.recentEvolutions.length > 0) {
    const latest = snap.recentEvolutions[0]!;
    if (latest.highlights.length > 0) {
      lines.push(`最近一次能力迭代摘要：${latest.highlights.join("；")}`);
    }
  }
  lines.push(`当前可受控查阅的本地项目与目录数：${snap.readableProjectCount} 个`);
  if (boundRepos.length > 0) {
    lines.push(`已绑定的可定制开发代码仓：${boundRepos.map((b) => `${b.alias}(${b.repoRoot})`).join(" | ")}`);
  }
  lines.push("已装载的能力剧本（遇到对应诉求务必优先调用以下工具，绝不凭空猜或误报做不到）：");
  for (const t of snap.tools) {
    lines.push(`- ${t.title} [${t.toolName}]：${t.summary}；触发时机：${t.whenToUse.join(" / ")}`);
  }
  if (snap.installedSkills.length > 0) {
    lines.push(
      `已安装的扩展技能：${snap.installedSkills.slice(0, 8).map((s) => `${s.name}(${s.description})`).join("；")}`,
    );
  }
  return lines.join("\n");
}

export interface CapabilityAwarenessOptions {
  dataDir: string;
  manifestPath?: string;
  workspaceRoot?: string;
  knowledgeGraph?: SugentKnowledgeGraph;
  recordInKnowledgeGraph?: boolean;
  tools: readonly CapabilityDescriptor[];
  nowIso?: () => string;
}

export class CapabilityAwarenessEngine {
  readonly filePath: string;
  readonly bootBuild: BuildManifest | undefined;
  private readonly nowIsoFn: () => string;
  private history: EvolutionRecord[] = [];

  constructor(private readonly opts: CapabilityAwarenessOptions) {
    this.filePath = path.join(path.resolve(opts.dataDir), "sugent-stewardship", "capability-evolution.json");
    this.nowIsoFn = opts.nowIso ?? (() => new Date().toISOString());
    this.bootBuild = readBuildManifest(opts.manifestPath);
    this.loadAndRecordBoot();
  }
  private loadAndRecordBoot(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as { history?: EvolutionRecord[] };
        if (Array.isArray(parsed?.history)) this.history = parsed.history.filter((x) => typeof x?.buildId === "string");
      }
    } catch {
      this.history = [];
    }
    if (!this.bootBuild) return;
    if (!this.history.some((h) => h.buildId === this.bootBuild!.buildId)) {
      const rec: EvolutionRecord = {
        buildId: this.bootBuild.buildId,
        version: this.bootBuild.version,
        recordedAtIso: this.nowIsoFn(),
        highlights: this.bootBuild.capabilityHighlights,
      };
      this.history = [rec, ...this.history].slice(0, 10);
      writeJsonAtomic600(this.filePath, { history: this.history });
      if (this.opts.knowledgeGraph && (this.opts.recordInKnowledgeGraph || Boolean(this.opts.knowledgeGraph.getNode("proj:sugent")))) {
        this.opts.knowledgeGraph.applyDelta(
          {
            nodes: [
              {
                id: `cap:build:${this.bootBuild.buildId}`,
                kind: "tool",
                name: `Sugent 能力版本 ${this.bootBuild.buildId}`,
                summary: this.bootBuild.capabilityHighlights.join("；") || `构建于 ${this.bootBuild.builtAtIso}`,
                tags: ["capability", "self-evolution"],
                reinforcements: 2,
              },
            ],
            edges: [
              {
                from: "proj:sugent",
                relation: "evolves_via",
                to: `cap:build:${this.bootBuild.buildId}`,
                source: "capability-awareness",
              },
            ],
          },
          this.nowIsoFn(),
        );
      }
    }
  }

  checkDrift(): RuntimeDriftStatus {
    const disk = readBuildManifest(this.opts.manifestPath);
    if (!disk) {
      return {
        ...(this.bootBuild ? { bootBuildId: this.bootBuild.buildId } : {}),
        drifted: false,
        summary: "源码实时态运行中（无独立构建清单）。",
      };
    }
    if (!this.bootBuild || disk.buildId !== this.bootBuild.buildId) {
      return {
        ...(this.bootBuild ? { bootBuildId: this.bootBuild.buildId } : {}),
        diskBuildId: disk.buildId,
        diskBuiltAtIso: disk.builtAtIso,
        drifted: true,
        summary: `磁盘已于 ${disk.builtAtIso} 编译新版 ${disk.buildId}，当前进程仍运行旧版 ${this.bootBuild?.buildId ?? "unknown"}。`,
      };
    }
    return {
      bootBuildId: this.bootBuild.buildId,
      diskBuildId: disk.buildId,
      diskBuiltAtIso: disk.builtAtIso,
      drifted: false,
      summary: `当前运行版本与磁盘最新构建一致（${this.bootBuild.buildId}）。`,
    };
  }

  snapshot(readableProjectCount = 0): CapabilityAwarenessSnapshot {
    return {
      ...(this.bootBuild ? { bootBuild: this.bootBuild } : {}),
      drift: this.checkDrift(),
      tools: [...this.opts.tools],
      installedSkills: scanInstalledSkills(this.opts.dataDir, this.opts.workspaceRoot),
      recentEvolutions: [...this.history],
      readableProjectCount,
    };
  }
}
