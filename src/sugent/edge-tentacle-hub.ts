import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  OpsInboxItem,
  OpsRemoteCommand,
  OpsStewardPendingSnapshot,
  OpsStewardProjectItem,
} from "./ops-bridge-client.js";

export type EdgePrivacyTier = 0 | 1 | 2;

export type EdgeCommandAction =
  | "dispatch_antigravity_new"
  | "dispatch_antigravity_resume"
  | "sync_pulse_now"
  | "execute_approved_inbox";

export type EdgeCommandStatus = "pending" | "accepted" | "completed" | "failed";

export interface EdgeSessionPulseInput {
  projectKey: string;
  conversationId: string;
  title: string;
  isRunning: boolean;
  stepCount: number;
  activeSubagentCount: number;
  subagentCount?: number;
  lastModifiedMs?: number;
}

export interface EdgeRunningSessionSummary {
  conversationId: string;
  title: string;
  stepCount: number;
  activeSubagentCount: number;
  subagentCount?: number;
  lastModifiedMs?: number;
  nodeId?: string;
}

export interface EdgeProjectPulseItem extends OpsStewardProjectItem {
  runningSessions?: EdgeRunningSessionSummary[];
}

export interface ParsedRepoStatus {
  stageGoal?: string;
  landed: string[];
  inflight: Array<{ text: string; nodeId?: string; surface?: string; updatedAt?: string }>;
  nextActions: string[];
  blockers: string[];
  reviewState?: string;
  updatedBy?: string;
  updatedAt?: string;
}

export interface ParsedRepoRoadmap {
  activeNode?: {
    code?: string;
    title: string;
    status: string;
    progress: { done: number; total: number; pct: number };
  };
  totals: { done: number; total: number; pct: number };
}

export interface ScanLocalProjectsForEdgeOptions {
  projectsRootDirs: readonly string[];
  nodeId: string;
  defaultTier?: EdgePrivacyTier;
  resolveTier?: (projectKey: string, repoPath: string) => EdgePrivacyTier;
  sessions?: ReadonlyArray<EdgeSessionPulseInput>;
  nowIso?: string;
  maxProjects?: number;
}

export interface EdgeNodeStatus {
  nodeId: string;
  platform?: string;
  hostname?: string;
  lastSeenAtIso: string;
  online: boolean;
  staleAfterMs: number;
  projectCount: number;
}

export interface EdgeQueuedCommand extends OpsRemoteCommand {
  id: string;
  targetNodeId: string;
  action: EdgeCommandAction;
  title: string;
  summary?: string;
  prompt?: string;
  conversationId?: string;
  projectKey?: string;
  workspaceHint?: string;
  status: EdgeCommandStatus;
  createdAtIso: string;
  pulledAtIso?: string;
  ackedAtIso?: string;
  updatedAtIso?: string;
  pullCount?: number;
}

export interface EdgeTentacleHubOptions {
  dataDir: string;
  edgeTokens?: readonly string[];
  staleAfterMs?: number;
  commandLeaseMs?: number;
  maxCommandHistory?: number;
  now?: () => number;
}

export interface EdgeIngestPulseInput {
  nodeId: string;
  platform?: string;
  hostname?: string;
  atIso?: string;
  projects: readonly EdgeProjectPulseItem[];
}

export interface EdgeEnqueueCommandInput {
  targetNodeId: string;
  action: EdgeCommandAction;
  title: string;
  summary?: string;
  prompt?: string;
  conversationId?: string;
  projectKey?: string;
  workspaceHint?: string;
  createdAtIso?: string;
}

export interface EdgeAckCommandInput {
  nodeId: string;
  status: "accepted" | "completed" | "failed";
  summary?: string;
  conversationId?: string;
  atIso?: string;
}

export interface EdgeAckCommandResult {
  ok: boolean;
  idempotent?: boolean;
  command?: EdgeQueuedCommand;
  ownerNotifyText?: string;
}

export interface EdgeTentacleRunnerOptions {
  hubUrl: string;
  edgeToken: string;
  nodeId: string;
  projectsRootDirs: readonly string[];
  fetchImpl?: typeof fetch;
  scanSessions?: () => ReadonlyArray<EdgeSessionPulseInput>;
  dispatchAntigravity?: (
    cmd: EdgeQueuedCommand,
  ) => Promise<{ ok: boolean; summary?: string; conversationId?: string }>;
  intervalMs?: number;
  nowIso?: () => string;
  defaultTier?: EdgePrivacyTier;
  resolveTier?: (projectKey: string, repoPath: string) => EdgePrivacyTier;
  platform?: string;
  hostname?: string;
  maxProjects?: number;
}

interface PersistedNodeRecord {
  nodeId: string;
  platform?: string;
  hostname?: string;
  lastSeenAtIso: string;
  projectCount: number;
}

interface PersistedEdgeFleetState {
  version: 1;
  updatedAtIso: string;
  nodes: Record<string, PersistedNodeRecord>;
  nodeProjects: Record<string, EdgeProjectPulseItem[]>;
  commands: EdgeQueuedCommand[];
}

const DEFAULT_STALE_AFTER_MS = 5 * 60_000;
const DEFAULT_COMMAND_LEASE_MS = 120_000;
const DEFAULT_MAX_COMMAND_HISTORY = 500;
const DEFAULT_RUNNER_INTERVAL_MS = 45_000;
const PLACEHOLDER_NONE_RE = /^(?:无|无卡点|无阻塞|暂无.*|none|n\/a)[。！!.\s]*$/i;

export function redactLocalPaths(text: string): string {
  if (!text) return "";
  return text
    .replace(
      /(^|[^A-Za-z0-9_./:-])(\/(?:Users|home|Volumes|private\/var|var\/folders|opt)\/[^\s`"'<>()[\]{},;，。；：！？、）》】]+)/g,
      "$1[local-path]",
    )
    .replace(
      /(^|[^A-Za-z0-9_./\\-])([A-Za-z]:[\\/](?:[^\s`"'<>()[\]{},;，。；：！？、）》】]+))/g,
      "$1[local-path]",
    );
}

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

type StatusSectionKey = "stageGoal" | "landed" | "inflight" | "nextActions" | "blockers";

function classifyStatusHeading(rawHeading: string): StatusSectionKey | null {
  const cleaned = rawHeading.replace(/^[0-9]+[.)、\s-]*/, "").trim();
  if (cleaned.startsWith("阶段目标")) return "stageGoal";
  if (cleaned.startsWith("最近完成")) return "landed";
  if (cleaned.startsWith("在途")) return "inflight";
  if (cleaned.startsWith("下一步")) return "nextActions";
  if (cleaned.startsWith("卡点")) return "blockers";
  return null;
}

function extractCleanMarkdownLines(lines: readonly string[]): string[] {
  const items: string[] = [];
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || (trimmed.startsWith("<!--") && trimmed.endsWith("-->"))) continue;
    const stripped = trimmed
      .replace(/^[-*+]\s+(?:\[[xX ]\]\s+)?/, "")
      .replace(/^\d+[.)]\s+/, "")
      .trim();
    if (!stripped || PLACEHOLDER_NONE_RE.test(stripped)) continue;
    items.push(stripped);
  }
  return items;
}

export function parseRepoStatusMarkdown(markdown: string): ParsedRepoStatus {
  const normalized = markdown.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  let body = normalized;
  let reviewState: string | undefined;
  let updatedBy: string | undefined;
  let updatedAt: string | undefined;

  const fmMatch = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/.exec(normalized);
  if (fmMatch) {
    body = normalized.slice(fmMatch[0].length);
    for (const rawLine of (fmMatch[1] ?? "").split("\n")) {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const sepIdx = trimmed.indexOf(":");
      if (sepIdx <= 0) continue;
      const key = trimmed.slice(0, sepIdx).trim();
      const val = unquoteYamlScalar(trimmed.slice(sepIdx + 1));
      if (!val) continue;
      if (key === "review_state") reviewState = val;
      else if (key === "updated_by") updatedBy = val;
      else if (key === "updated_at") updatedAt = val;
    }
  }

  const buckets: Record<StatusSectionKey, string[]> = {
    stageGoal: [],
    landed: [],
    inflight: [],
    nextActions: [],
    blockers: [],
  };

  let currentSection: StatusSectionKey | null = null;
  let inFence = false;
  for (const line of body.split("\n")) {
    if (/^\s{0,3}(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h2Match = /^##\s+(.+?)\s*$/.exec(line);
    if (h2Match) {
      currentSection = classifyStatusHeading(h2Match[1] ?? "");
      continue;
    }
    if (/^#\s+/.test(line)) {
      currentSection = null;
      continue;
    }
    if (currentSection) buckets[currentSection].push(line);
  }

  const stageGoalItems = extractCleanMarkdownLines(buckets.stageGoal);
  const stageGoal = stageGoalItems.length > 0 ? stageGoalItems.join(" ") : undefined;
  return {
    ...(stageGoal ? { stageGoal } : {}),
    landed: extractCleanMarkdownLines(buckets.landed),
    inflight: extractCleanMarkdownLines(buckets.inflight).map((text) => ({ text })),
    nextActions: extractCleanMarkdownLines(buckets.nextActions),
    blockers: extractCleanMarkdownLines(buckets.blockers),
    ...(reviewState ? { reviewState } : {}),
    ...(updatedBy ? { updatedBy } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

interface RoadmapSectionTrack {
  rawHeading: string;
  done: number;
  open: number;
}

function splitRoadmapHeadingCodeAndTitle(rawHeading: string): { code?: string; title: string } {
  const trimmed = rawHeading.trim();
  const match =
    /^\[?((?:Phase|Stage|Wave|Milestone)\s+[A-Za-z0-9._-]+|[A-Za-z]+\d+(?:\.\d+)*)\]?\s*(?:[:\-—·]\s*|\s+)(.+)$/i.exec(
      trimmed,
    );
  if (match?.[1] && match[2]) {
    return { code: match[1].trim(), title: match[2].trim() };
  }
  return { title: trimmed };
}

export function parseRepoRoadmapMarkdown(markdown: string): ParsedRepoRoadmap {
  const normalized = markdown.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const sections: RoadmapSectionTrack[] = [];
  let currentSection: RoadmapSectionTrack | null = null;
  let totalDone = 0;
  let totalOpen = 0;
  let inFence = false;

  for (const line of normalized.split("\n")) {
    if (/^\s{0,3}(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const headingMatch = /^#{2,3}\s+(.+?)\s*$/.exec(line);
    if (headingMatch?.[1]) {
      currentSection = { rawHeading: headingMatch[1], done: 0, open: 0 };
      sections.push(currentSection);
      continue;
    }
    const cbMatch = /^\s*[-*+]\s+\[([xX ])\]\s+/.exec(line);
    if (cbMatch) {
      const isDone = cbMatch[1]?.toLowerCase() === "x";
      if (isDone) {
        totalDone += 1;
        if (currentSection) currentSection.done += 1;
      } else {
        totalOpen += 1;
        if (currentSection) currentSection.open += 1;
      }
    }
  }

  const grandTotal = totalDone + totalOpen;
  const totals = {
    done: totalDone,
    total: grandTotal,
    pct: grandTotal > 0 ? Math.round((totalDone / grandTotal) * 100) : 0,
  };

  const withBoxes = sections.filter((s) => s.done + s.open > 0);
  const chosen = withBoxes.find((s) => s.open > 0) ?? withBoxes[withBoxes.length - 1];
  if (!chosen) return { totals };

  const secTotal = chosen.done + chosen.open;
  const { code, title } = splitRoadmapHeadingCodeAndTitle(chosen.rawHeading);
  return {
    activeNode: {
      ...(code ? { code } : {}),
      title,
      status: chosen.open > 0 ? "in_progress" : "completed",
      progress: {
        done: chosen.done,
        total: secTotal,
        pct: secTotal > 0 ? Math.round((chosen.done / secTotal) * 100) : 0,
      },
    },
    totals,
  };
}

function deriveProjectKeyFromRepo(repoDir: string, nodeId: string): string {
  const folderName = path.basename(repoDir).toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  try {
    const gitConfigPath = path.join(repoDir, ".git", "config");
    if (fs.existsSync(gitConfigPath)) {
      const raw = fs.readFileSync(gitConfigPath, "utf8");
      const originBlock = /\[remote\s+"origin"\]([\s\S]*?)(?:\n\[|$)/.exec(raw)?.[1] ?? raw;
      const urlMatch = /^\s*url\s*=\s*(.+?)\s*$/m.exec(originBlock);
      if (urlMatch?.[1]) {
        const remote = urlMatch[1].trim().replace(/\.git$/i, "");
        const slugMatch = /[:/]([^/:]+\/[^/:]+)$/.exec(remote);
        if (slugMatch?.[1]) {
          return `repo:${slugMatch[1].toLowerCase()}`;
        }
      }
    }
  } catch {
    // fallback to local key
  }
  return `local:${nodeId.toLowerCase()}:${folderName}`;
}

export function scanLocalProjectsForEdge(opts: ScanLocalProjectsForEdgeOptions): EdgeProjectPulseItem[] {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const defaultTier: EdgePrivacyTier = opts.defaultTier ?? 2;
  const maxProjects = Math.max(1, opts.maxProjects ?? 40);
  const candidateDirs: string[] = [];
  const seenRealPaths = new Set<string>();

  for (const rootDir of opts.projectsRootDirs) {
    if (!rootDir || !fs.existsSync(rootDir)) continue;
    const selfHasMarker =
      fs.existsSync(path.join(rootDir, ".git")) ||
      fs.existsSync(path.join(rootDir, "STATUS.md")) ||
      fs.existsSync(path.join(rootDir, "package.json"));
    if (selfHasMarker) {
      const resolvedSelf = path.resolve(rootDir);
      if (!seenRealPaths.has(resolvedSelf)) {
        seenRealPaths.add(resolvedSelf);
        candidateDirs.push(resolvedSelf);
      }
      continue;
    }
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(rootDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
      const fullPath = path.join(rootDir, ent.name);
      const hasMarker =
        fs.existsSync(path.join(fullPath, ".git")) ||
        fs.existsSync(path.join(fullPath, "STATUS.md")) ||
        fs.existsSync(path.join(fullPath, "package.json"));
      if (!hasMarker) continue;
      const resolved = path.resolve(fullPath);
      if (seenRealPaths.has(resolved)) continue;
      seenRealPaths.add(resolved);
      candidateDirs.push(resolved);
    }
  }

  const out: EdgeProjectPulseItem[] = [];
  for (const repoDir of candidateDirs.slice(0, maxProjects)) {
    const rawKey = deriveProjectKeyFromRepo(repoDir, opts.nodeId);
    const tier = opts.resolveTier ? opts.resolveTier(rawKey, repoDir) : defaultTier;
    const displayName = path.basename(repoDir);

    const matchingSessions = (opts.sessions ?? []).filter((s) => s.projectKey === rawKey);
    const runningSessions = matchingSessions.filter((s) => s.isRunning);

    if (tier === 0) {
      const hash8 = crypto.createHash("sha256").update(rawKey).digest("hex").slice(0, 8);
      out.push({
        projectKey: `tier0:${hash8}`,
        nodeId: opts.nodeId,
        nodes: [opts.nodeId],
        tier: 0,
        privacyTier: 0,
        status: runningSessions.length > 0 ? "running" : "idle",
        updatedAtIso: nowIso,
      });
      continue;
    }

    let parsedStatus: ParsedRepoStatus | undefined;
    const statusMdPath = path.join(repoDir, "STATUS.md");
    if (fs.existsSync(statusMdPath)) {
      try {
        parsedStatus = parseRepoStatusMarkdown(fs.readFileSync(statusMdPath, "utf8"));
      } catch {
        parsedStatus = undefined;
      }
    }

    let parsedRoadmap: ParsedRepoRoadmap | undefined;
    const roadmapCandidates = [path.join(repoDir, "docs", "ROADMAP.md"), path.join(repoDir, "ROADMAP.md")];
    for (const rp of roadmapCandidates) {
      if (fs.existsSync(rp)) {
        try {
          parsedRoadmap = parseRepoRoadmapMarkdown(fs.readFileSync(rp, "utf8"));
          break;
        } catch {
          // ignore unreadable roadmap
        }
      }
    }

    const sanitizedGoal = parsedStatus?.stageGoal ? redactLocalPaths(parsedStatus.stageGoal) : undefined;
    const boardStatus =
      parsedStatus?.blockers && parsedStatus.blockers.length > 0
        ? "blocked"
        : runningSessions.length > 0 || (parsedStatus?.inflight.length ?? 0) > 0
          ? "active"
          : "idle";

    if (tier === 1) {
      out.push({
        projectKey: rawKey,
        displayName: redactLocalPaths(displayName),
        nodeId: opts.nodeId,
        nodes: [opts.nodeId],
        tier: 1,
        privacyTier: 1,
        boardStatus,
        status: runningSessions.length > 0 ? "running" : "idle",
        updatedAtIso: parsedStatus?.updatedAt || nowIso,
        lastActiveAt: parsedStatus?.updatedAt || nowIso,
        ...(sanitizedGoal ? { sanitizedSummary: sanitizedGoal } : {}),
        ...(sanitizedGoal || parsedStatus?.reviewState
          ? {
              statusCard: {
                ...(sanitizedGoal ? { stageGoal: sanitizedGoal } : {}),
                ...(parsedStatus?.reviewState ? { reviewState: parsedStatus.reviewState } : {}),
                ...(parsedStatus?.updatedAt ? { updatedAt: parsedStatus.updatedAt } : {}),
              },
            }
          : {}),
        ...(parsedRoadmap ? { roadmapSummary: parsedRoadmap } : {}),
      });
      continue;
    }

    const landed = (parsedStatus?.landed ?? []).slice(0, 6).map(redactLocalPaths);
    const nextActions = (parsedStatus?.nextActions ?? []).slice(0, 6).map(redactLocalPaths);
    const blockers = (parsedStatus?.blockers ?? []).slice(0, 4).map(redactLocalPaths);
    const inflight = [
      ...runningSessions.slice(0, 5).map((s) => ({
        text: redactLocalPaths(s.title || s.conversationId.slice(0, 8)),
        nodeId: opts.nodeId,
        surface: "antigravity",
        updatedAt: nowIso,
      })),
      ...(parsedStatus?.inflight ?? []).slice(0, 5).map((it) => ({
        text: redactLocalPaths(it.text),
        nodeId: opts.nodeId,
      })),
    ];

    const summaryParts = [sanitizedGoal, landed[0], nextActions[0]].filter(Boolean);
    out.push({
      projectKey: rawKey,
      displayName: redactLocalPaths(displayName),
      nodeId: opts.nodeId,
      nodes: [opts.nodeId],
      tier: 2,
      privacyTier: 2,
      boardStatus,
      status: runningSessions.length > 0 ? "running" : "idle",
      ...(summaryParts.length > 0 ? { sanitizedSummary: summaryParts.join(" · ").slice(0, 280) } : {}),
      updatedAtIso: parsedStatus?.updatedAt || nowIso,
      lastActiveAt: parsedStatus?.updatedAt || nowIso,
      ...(parsedStatus || runningSessions.length > 0
        ? {
            statusCard: {
              ...(sanitizedGoal ? { stageGoal: sanitizedGoal } : {}),
              landed,
              inflight,
              nextActions,
              blockers,
              ...(parsedStatus?.reviewState ? { reviewState: parsedStatus.reviewState } : {}),
              ...(parsedStatus?.updatedBy ? { updatedBy: redactLocalPaths(parsedStatus.updatedBy) } : {}),
              updatedAt: parsedStatus?.updatedAt || nowIso,
              source: "STATUS.md",
            },
            executiveSummary: {
              ...(sanitizedGoal ? { goalText: sanitizedGoal } : {}),
              ...(landed[0] ? { progressText: landed[0] } : {}),
              ...(nextActions[0] ? { nextActionText: nextActions[0] } : {}),
              updatedAt: parsedStatus?.updatedAt || nowIso,
            },
          }
        : {}),
      ...(parsedRoadmap ? { roadmapSummary: parsedRoadmap } : {}),
      ...(runningSessions.length > 0
        ? {
            runningSessions: runningSessions.slice(0, 6).map((s) => ({
              conversationId: s.conversationId,
              title: redactLocalPaths(s.title || s.conversationId.slice(0, 8)),
              stepCount: s.stepCount,
              activeSubagentCount: s.activeSubagentCount,
              ...(s.subagentCount !== undefined ? { subagentCount: s.subagentCount } : {}),
              ...(s.lastModifiedMs !== undefined ? { lastModifiedMs: s.lastModifiedMs } : {}),
              nodeId: opts.nodeId,
            })),
          }
        : {}),
    });
  }

  return out;
}

export function verifyEdgeToken(
  providedToken: string | undefined,
  expectedTokens: readonly string[],
): boolean {
  const cleanProvided = String(providedToken ?? "").trim();
  if (!cleanProvided) return false;
  const providedDigest = crypto.createHash("sha256").update(cleanProvided).digest();
  let matched = false;
  for (const rawExpected of expectedTokens) {
    const cleanExpected = String(rawExpected ?? "").trim();
    if (!cleanExpected) continue;
    const expectedDigest = crypto.createHash("sha256").update(cleanExpected).digest();
    if (crypto.timingSafeEqual(providedDigest, expectedDigest)) {
      matched = true;
    }
  }
  return matched;
}

function writeJsonAtomic600(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, filePath);
}

function parseIsoMs(iso: string | undefined): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

export class EdgeTentacleHub {
  private readonly statePath: string;
  private readonly staleAfterMs: number;
  private readonly commandLeaseMs: number;
  private readonly maxCommandHistory: number;
  private readonly nowFn: () => number;
  private edgeTokens: string[];
  private state: PersistedEdgeFleetState;

  constructor(opts: EdgeTentacleHubOptions) {
    this.statePath = path.join(opts.dataDir, "sugent-stewardship", "edge-fleet-state.json");
    this.staleAfterMs = Math.max(10_000, opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS);
    this.commandLeaseMs = Math.max(10_000, opts.commandLeaseMs ?? DEFAULT_COMMAND_LEASE_MS);
    this.maxCommandHistory = Math.max(20, opts.maxCommandHistory ?? DEFAULT_MAX_COMMAND_HISTORY);
    this.nowFn = opts.now ?? (() => Date.now());
    this.edgeTokens = (opts.edgeTokens ?? []).map((t) => t.trim()).filter(Boolean);
    this.state = this.loadState();
  }

  setEdgeTokens(tokens: readonly string[]): void {
    this.edgeTokens = tokens.map((t) => t.trim()).filter(Boolean);
  }

  hasConfiguredTokens(): boolean {
    return this.edgeTokens.length > 0;
  }

  verifyToken(providedToken: string | undefined): boolean {
    return verifyEdgeToken(providedToken, this.edgeTokens);
  }

  private loadState(): PersistedEdgeFleetState {
    try {
      if (fs.existsSync(this.statePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as Partial<PersistedEdgeFleetState>;
        if (parsed && parsed.version === 1) {
          return {
            version: 1,
            updatedAtIso: typeof parsed.updatedAtIso === "string" ? parsed.updatedAtIso : new Date(this.nowFn()).toISOString(),
            nodes: parsed.nodes && typeof parsed.nodes === "object" ? parsed.nodes : {},
            nodeProjects: parsed.nodeProjects && typeof parsed.nodeProjects === "object" ? parsed.nodeProjects : {},
            commands: Array.isArray(parsed.commands) ? parsed.commands : [],
          };
        }
      }
    } catch {
      // fall through to clean initial state
    }
    return {
      version: 1,
      updatedAtIso: new Date(this.nowFn()).toISOString(),
      nodes: {},
      nodeProjects: {},
      commands: [],
    };
  }

  private persist(): void {
    this.state.updatedAtIso = new Date(this.nowFn()).toISOString();
    writeJsonAtomic600(this.statePath, this.state);
  }

  listNodes(nowMs = this.nowFn()): EdgeNodeStatus[] {
    return Object.values(this.state.nodes)
      .map((n) => {
        const seenMs = parseIsoMs(n.lastSeenAtIso);
        return {
          nodeId: n.nodeId,
          ...(n.platform ? { platform: n.platform } : {}),
          ...(n.hostname ? { hostname: n.hostname } : {}),
          lastSeenAtIso: n.lastSeenAtIso,
          online: seenMs > 0 && nowMs - seenMs <= this.staleAfterMs,
          staleAfterMs: this.staleAfterMs,
          projectCount: n.projectCount,
        };
      })
      .sort((a, b) => Number(b.online) - Number(a.online) || parseIsoMs(b.lastSeenAtIso) - parseIsoMs(a.lastSeenAtIso));
  }

  ingestNodePulse(input: EdgeIngestPulseInput): {
    ok: true;
    nodeId: string;
    projectCount: number;
    snapshot: OpsStewardPendingSnapshot;
  } {
    const nodeId = String(input.nodeId ?? "").trim() || "unknown-node";
    const atIso = input.atIso && parseIsoMs(input.atIso) > 0 ? input.atIso : new Date(this.nowFn()).toISOString();
    const sanitizedProjects: EdgeProjectPulseItem[] = (input.projects ?? []).map((p) => ({
      ...p,
      nodeId,
      nodes: [nodeId],
      ...(p.displayName ? { displayName: redactLocalPaths(p.displayName) } : {}),
      ...(p.sanitizedSummary ? { sanitizedSummary: redactLocalPaths(p.sanitizedSummary) } : {}),
      updatedAtIso: p.updatedAtIso || atIso,
    }));

    this.state.nodes[nodeId] = {
      nodeId,
      ...(input.platform ? { platform: input.platform } : {}),
      ...(input.hostname ? { hostname: input.hostname } : {}),
      lastSeenAtIso: atIso,
      projectCount: sanitizedProjects.length,
    };
    this.state.nodeProjects[nodeId] = sanitizedProjects;
    this.persist();

    return {
      ok: true,
      nodeId,
      projectCount: sanitizedProjects.length,
      snapshot: this.toOpsStewardSnapshot(),
    };
  }

  toOpsStewardSnapshot(nowMs = this.nowFn()): OpsStewardPendingSnapshot {
    const mergedByKey = new Map<string, EdgeProjectPulseItem & { _cardMs: number; _pulseMs: number }>();

    for (const [nodeId, projects] of Object.entries(this.state.nodeProjects)) {
      for (const proj of projects) {
        const key = proj.projectKey;
        if (!key) continue;
        const cardMs = parseIsoMs(proj.statusCard?.updatedAt) || parseIsoMs(proj.updatedAtIso);
        const pulseMs = parseIsoMs(proj.updatedAtIso) || parseIsoMs(this.state.nodes[nodeId]?.lastSeenAtIso);
        const existing = mergedByKey.get(key);
        if (!existing) {
          mergedByKey.set(key, {
            ...proj,
            nodeId,
            nodes: Array.from(new Set([...(proj.nodes ?? []), nodeId])),
            _cardMs: cardMs,
            _pulseMs: pulseMs,
          });
          continue;
        }

        const combinedNodes = Array.from(new Set([...(existing.nodes ?? []), ...(proj.nodes ?? []), nodeId]));
        const isRunning = existing.status === "running" || proj.status === "running";
        const useIncomingCard = cardMs >= existing._cardMs && Boolean(proj.statusCard);
        const useIncomingBase = pulseMs >= existing._pulseMs;
        const mergedSessions = [
          ...(existing.runningSessions ?? []),
          ...(proj.runningSessions ?? []),
        ].slice(0, 8);

        mergedByKey.set(key, {
          ...(useIncomingBase ? { ...existing, ...proj } : { ...proj, ...existing }),
          statusCard: useIncomingCard ? proj.statusCard : existing.statusCard ?? proj.statusCard,
          executiveSummary: useIncomingCard
            ? proj.executiveSummary ?? existing.executiveSummary
            : existing.executiveSummary ?? proj.executiveSummary,
          roadmapSummary: useIncomingCard
            ? proj.roadmapSummary ?? existing.roadmapSummary
            : existing.roadmapSummary ?? proj.roadmapSummary,
          nodeId: useIncomingBase ? nodeId : existing.nodeId,
          nodes: combinedNodes,
          status: isRunning ? "running" : (useIncomingBase ? proj.status : existing.status),
          boardStatus:
            existing.boardStatus === "blocked" || proj.boardStatus === "blocked"
              ? "blocked"
              : isRunning
                ? "active"
                : (useIncomingBase ? proj.boardStatus : existing.boardStatus),
          ...(mergedSessions.length > 0 ? { runningSessions: mergedSessions } : {}),
          _cardMs: Math.max(existing._cardMs, cardMs),
          _pulseMs: Math.max(existing._pulseMs, pulseMs),
        });
      }
    }

    const projects: OpsStewardProjectItem[] = Array.from(mergedByKey.values())
      .sort(
        (a, b) =>
          Number(b.status === "running") - Number(a.status === "running") ||
          b._pulseMs - a._pulseMs ||
          b._cardMs - a._cardMs,
      )
      .map(({ _cardMs: _c, _pulseMs: _p, ...rest }) => rest);

    const stageGoals = projects
      .map((p) => p.statusCard?.stageGoal)
      .filter((g): g is string => Boolean(g))
      .slice(0, 8);

    const pendingInbox: OpsInboxItem[] = [];
    return {
      fetchedAtIso: new Date(nowMs).toISOString(),
      projects,
      pendingInbox,
      ...(stageGoals.length > 0 ? { stageGoals } : {}),
    };
  }

  enqueueCommand(input: EdgeEnqueueCommandInput): EdgeQueuedCommand {
    const nowIso = input.createdAtIso ?? new Date(this.nowFn()).toISOString();
    const cmd: EdgeQueuedCommand = {
      id: `ecmd-${this.nowFn().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
      targetNodeId: String(input.targetNodeId ?? "").trim() || "local-mac",
      action: input.action,
      title: String(input.title ?? "").trim() || input.action,
      ...(input.summary ? { summary: input.summary } : {}),
      ...(input.prompt ? { prompt: input.prompt } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.projectKey ? { projectKey: input.projectKey } : {}),
      ...(input.workspaceHint ? { workspaceHint: input.workspaceHint } : {}),
      status: "pending",
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
      pullCount: 0,
    };
    this.state.commands.push(cmd);
    if (this.state.commands.length > this.maxCommandHistory) {
      this.state.commands.splice(0, this.state.commands.length - this.maxCommandHistory);
    }
    this.persist();
    return { ...cmd };
  }

  listCommands(opts?: { targetNodeId?: string; limit?: number }): EdgeQueuedCommand[] {
    const filtered = opts?.targetNodeId
      ? this.state.commands.filter((c) => c.targetNodeId === opts.targetNodeId)
      : this.state.commands;
    const lim = Math.max(1, opts?.limit ?? 50);
    return filtered.slice(-lim).map((c) => ({ ...c }));
  }

  pullPendingCommands(nodeId: string, nowIso?: string): EdgeQueuedCommand[] {
    const cleanNode = String(nodeId ?? "").trim();
    if (!cleanNode) return [];
    const nowMs = nowIso ? parseIsoMs(nowIso) || this.nowFn() : this.nowFn();
    const stampIso = new Date(nowMs).toISOString();
    const pulled: EdgeQueuedCommand[] = [];

    for (const cmd of this.state.commands) {
      if (cmd.targetNodeId !== cleanNode) continue;
      if (cmd.status !== "pending") continue;
      const lastPulledMs = parseIsoMs(cmd.pulledAtIso);
      if (lastPulledMs > 0 && nowMs - lastPulledMs < this.commandLeaseMs) {
        continue;
      }
      cmd.pulledAtIso = stampIso;
      cmd.updatedAtIso = stampIso;
      cmd.pullCount = (cmd.pullCount ?? 0) + 1;
      pulled.push({ ...cmd });
    }

    if (pulled.length > 0) this.persist();
    return pulled;
  }

  ackCommand(commandId: string, input: EdgeAckCommandInput): EdgeAckCommandResult {
    const cleanId = String(commandId ?? "").trim();
    const cmd = this.state.commands.find((c) => c.id === cleanId);
    if (!cmd) return { ok: false };

    const atIso = input.atIso ?? new Date(this.nowFn()).toISOString();
    if (
      (cmd.status === "completed" || cmd.status === "failed") &&
      cmd.status === input.status
    ) {
      return { ok: true, idempotent: true, command: { ...cmd } };
    }

    const wasTerminal = cmd.status === "completed" || cmd.status === "failed";
    cmd.status = input.status;
    cmd.ackedAtIso = atIso;
    cmd.updatedAtIso = atIso;
    if (input.summary) cmd.summary = redactLocalPaths(input.summary).slice(0, 360);
    if (input.conversationId) cmd.conversationId = input.conversationId;
    this.persist();

    let ownerNotifyText: string | undefined;
    if (!wasTerminal && (input.status === "completed" || input.status === "failed")) {
      const statusLabel = input.status === "completed" ? "已完成" : "执行失败";
      const detail = cmd.summary ? `：${cmd.summary}` : "";
      ownerNotifyText = `【触手执行回执 · ${input.nodeId || cmd.targetNodeId}】${statusLabel}「${cmd.title}」${detail}`;
    }

    return {
      ok: true,
      command: { ...cmd },
      ...(ownerNotifyText ? { ownerNotifyText } : {}),
    };
  }
}

export class EdgeTentacleRunner {
  private readonly hubUrl: string;
  private readonly edgeToken: string;
  private readonly nodeId: string;
  private readonly projectsRootDirs: readonly string[];
  private readonly fetchFn: typeof fetch;
  private readonly nowIsoFn: () => string;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly opts: EdgeTentacleRunnerOptions) {
    this.hubUrl = opts.hubUrl.trim().replace(/\/+$/, "");
    this.edgeToken = opts.edgeToken.trim();
    this.nodeId = opts.nodeId.trim() || "local-mac";
    this.projectsRootDirs = opts.projectsRootDirs;
    this.fetchFn = opts.fetchImpl ?? globalThis.fetch;
    this.nowIsoFn = opts.nowIso ?? (() => new Date().toISOString());
    this.intervalMs = Math.max(10_000, opts.intervalMs ?? DEFAULT_RUNNER_INTERVAL_MS);
  }

  private headers(withJson = false): Record<string, string> {
    return {
      ...(withJson ? { "content-type": "application/json" } : {}),
      authorization: `Bearer ${this.edgeToken}`,
      "x-sugent-edge-token": this.edgeToken,
    };
  }

  async runCycleOnce(): Promise<{
    pulseOk: boolean;
    projectCount: number;
    commandsExecuted: number;
    errors: string[];
  }> {
    const errors: string[] = [];
    const sessions = this.opts.scanSessions ? this.opts.scanSessions() : [];
    const projects = scanLocalProjectsForEdge({
      projectsRootDirs: this.projectsRootDirs,
      nodeId: this.nodeId,
      ...(this.opts.defaultTier !== undefined ? { defaultTier: this.opts.defaultTier } : {}),
      ...(this.opts.resolveTier ? { resolveTier: this.opts.resolveTier } : {}),
      sessions,
      nowIso: this.nowIsoFn(),
      ...(this.opts.maxProjects !== undefined ? { maxProjects: this.opts.maxProjects } : {}),
    });

    let pulseOk = false;
    try {
      const pulseRes = await this.fetchFn(`${this.hubUrl}/amb/api/steward/edge/pulse`, {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({
          nodeId: this.nodeId,
          platform: this.opts.platform ?? process.platform,
          hostname: this.opts.hostname ?? os.hostname(),
          atIso: this.nowIsoFn(),
          projects,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      pulseOk = pulseRes.ok;
      if (!pulseRes.ok) errors.push(`PULSE_HTTP_${pulseRes.status}`);
    } catch (e) {
      errors.push(`PULSE_ERR:${(e as Error).message}`);
    }

    let commandsExecuted = 0;
    try {
      const cmdRes = await this.fetchFn(
        `${this.hubUrl}/amb/api/steward/edge/commands?nodeId=${encodeURIComponent(this.nodeId)}`,
        {
          method: "GET",
          headers: this.headers(false),
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!cmdRes.ok) {
        errors.push(`PULL_HTTP_${cmdRes.status}`);
      } else {
        const payload = (await cmdRes.json()) as { commands?: EdgeQueuedCommand[] };
        const commands = Array.isArray(payload.commands) ? payload.commands : [];
        for (const cmd of commands) {
          let ackBody: EdgeAckCommandInput;
          try {
            if (cmd.action === "sync_pulse_now") {
              ackBody = {
                nodeId: this.nodeId,
                status: "completed",
                summary: `已同步 ${projects.length} 个本地项目脉冲`,
              };
            } else if (this.opts.dispatchAntigravity) {
              const out = await this.opts.dispatchAntigravity(cmd);
              ackBody = {
                nodeId: this.nodeId,
                status: out.ok ? "completed" : "failed",
                ...(out.summary ? { summary: out.summary } : {}),
                ...(out.conversationId ? { conversationId: out.conversationId } : {}),
              };
            } else {
              ackBody = {
                nodeId: this.nodeId,
                status: "failed",
                summary: "当前触手未挂载 Antigravity 调度器",
              };
            }
            commandsExecuted += 1;
          } catch (err) {
            ackBody = {
              nodeId: this.nodeId,
              status: "failed",
              summary: (err as Error).message.slice(0, 240),
            };
          }

          await this.fetchFn(
            `${this.hubUrl}/amb/api/steward/edge/commands/${encodeURIComponent(cmd.id)}/ack`,
            {
              method: "POST",
              headers: this.headers(true),
              body: JSON.stringify(ackBody),
              signal: AbortSignal.timeout(15_000),
            },
          ).catch((ackErr) => {
            errors.push(`ACK_ERR:${(ackErr as Error).message}`);
          });
        }
      }
    } catch (e) {
      errors.push(`PULL_ERR:${(e as Error).message}`);
    }

    return {
      pulseOk,
      projectCount: projects.length,
      commandsExecuted,
      errors,
    };
  }

  async runOnce() {
    return this.runCycleOnce();
  }

  start(): void {
    if (this.timer) return;
    void this.runCycleOnce().catch(() => {});
    this.timer = setInterval(() => {
      void this.runCycleOnce().catch(() => {});
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
