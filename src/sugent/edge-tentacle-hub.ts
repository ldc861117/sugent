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
  workspaceRoot?: string;
  workspaceUris?: readonly string[];
  surface?: string;
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
    progress: {
      done: number;
      total: number;
      pct: number;
      codeDone?: number;
      codeTotal?: number;
      realDone?: number;
      realTotal?: number;
    };
    inProgressCount?: number;
    todoCount?: number;
    blockedCount?: number;
    hasExitGate?: boolean;
  };
  totals: {
    done: number;
    total: number;
    pct: number;
    codeDone?: number;
    codeTotal?: number;
    realDone?: number;
    realTotal?: number;
  };
}

export interface ScanLocalProjectsForEdgeOptions {
  projectsRootDirs: readonly string[];
  homeDir?: string;
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

export interface EdgeTentacleRunnerCycleResult {
  pulseOk: boolean;
  projectCount: number;
  commandsExecuted: number;
  errors: string[];
}

export interface EdgeTentacleRunnerOptions {
  hubUrl: string;
  edgeToken: string;
  nodeId: string;
  projectsRootDirs: readonly string[];
  homeDir?: string;
  fetchImpl?: typeof fetch;
  scanSessions?: () => ReadonlyArray<EdgeSessionPulseInput>;
  dispatchAntigravity?: (
    cmd: EdgeQueuedCommand,
  ) => Promise<{ ok: boolean; summary?: string; conversationId?: string }>;
  onCycle?: (result: EdgeTentacleRunnerCycleResult) => void;
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

interface RawRoadmapSection {
  level: number;
  rawHeading: string;
  lines: string[];
}

interface EvaluatedRoadmapStage {
  code?: string;
  title: string;
  isStageHeading: boolean;
  explicitActive: boolean;
  hasExitGate: boolean;
  done: number;
  inProgress: number;
  todo: number;
  blocked: number;
  codeDone: number;
  codeTotal: number;
  realDone: number;
  realTotal: number;
  status: string;
}

const STAGE_HEADING_PATTERNS: readonly RegExp[] = [
  /\b(Horizon\s*[A-Z]?\d+)\b/i,
  /\b(Milestone\s*[A-Z]?\d+)\b/i,
  /\b(Phase\s*[A-Z]?\d+)\b/i,
  /\b(Wave\s*[A-Z]?\d+)\b/i,
  /\b(Sprint\s*[A-Z]?\d+)\b/i,
  /\b(Stage\s*[A-Z]?\d+)\b/i,
  /(?:^|\s)(里程碑\s*(?:[A-Z]?\d+|[一二三四五六七八九十]+))(?=\s*[:：\-—（(]|$)/,
  /(?:^|\s)(第\s*(?:\d+|[一二三四五六七八九十]+)\s*阶段)(?=\s*[:：\-—（(]|$)/,
  /(?:^|\s)(阶段\s*(?:[A-Z]?\d+|[一二三四五六七八九十]+))(?=\s*[:：\-—（(]|$)/,
];

const DELIVERABLE_HEADER_RE = /^\*\*[^*]*(?:core deliverables|deliverables|核心交付|交付清单|关键任务)[^*]*\*\*/i;
const ENTRY_GATE_RE = /^\*\*[^*]*(?:entry gate|准入门禁|前置门禁)[^*]*\*\*\s*[:：]?\s*(.*)$/i;
const EXIT_GATE_RE = /^\*\*[^*]*(?:exit\s*\/?\s*profit gate|exit gate|profit gate|验收门禁|晋级门禁|DoD)[^*]*\*\*\s*[:：]?\s*(.*)$/i;
const META_BULLET_RE = /^\*\*[^*]*(?:entry gate|exit|profit gate|frozen|out-of-scope|战役目标|核心目标|验收门禁|DoD)[^*]*\*\*/i;
const DELIV_CODE_RE = /^(?:\*\*)?`?([A-Z]{1,3}\d+(?:\.\d+)+)`?(?:\*\*)?(?:\s|$|[：:])/;

function isExplicitActiveRoadmapHeading(rawHeading: string): boolean {
  if (/[（(\[【][^）)\]】]*(?:当前|活跃|进行中|current|active|in progress|wip)[^）)\]】]*[）)\]】]/i.test(rawHeading)) {
    return true;
  }
  if (/[🚧🔥👉]/u.test(rawHeading)) return true;
  return /^\s*(?:\d+[.、]\s*)?(?:当前(?:活跃)?阶段|current stage|active stage)\s*[:：]/i.test(rawHeading);
}

function splitRoadmapHeadingCodeAndTitle(rawHeading: string): { code?: string; title: string; isStageHeading: boolean } {
  const cleanedMarkers = rawHeading
    .replace(/[（(\[【][^）)\]】]*(?:当前|活跃|进行中|current|active|in progress|wip)[^）)\]】]*[）)\]】]/gi, "")
    .replace(/[🚧🔥👉]/gu, "")
    .trim();

  for (const pat of STAGE_HEADING_PATTERNS) {
    const m = pat.exec(cleanedMarkers);
    if (m?.[1]) {
      const code = m[1].trim();
      const rest = cleanedMarkers
        .slice(m.index + m[0].length)
        .replace(/^\s*\([A-Z]{1,3}\d+\)\s*/i, "")
        .replace(/^\s*[:：\-—·]\s*/, "")
        .replace(/\*\*|__|[`*]/g, "")
        .trim();
      return { code, title: rest || cleanedMarkers, isStageHeading: true };
    }
  }

  const fallbackMatch =
    /^\[?((?:Phase|Stage|Wave|Milestone|Horizon|Sprint)\s+[A-Za-z0-9._-]+|[A-Za-z]+\d+(?:\.\d+)*)\]?\s*(?:[:\-—·]\s*|\s+)(.+)$/i.exec(
      cleanedMarkers,
    );
  if (fallbackMatch?.[1] && fallbackMatch[2]) {
    return {
      code: fallbackMatch[1].trim(),
      title: fallbackMatch[2].replace(/\*\*|__|[`*]/g, "").trim(),
      isStageHeading: true,
    };
  }
  return { title: cleanedMarkers, isStageHeading: false };
}

function classifyRoadmapBulletItem(rawBody: string): "done" | "in_progress" | "blocked" | "todo" | null {
  let body = rawBody.trim();
  const cb = /^\[([ xX/~!-])\]\s*(.*)$/.exec(body);
  if (cb) {
    const mark = cb[1] ?? " ";
    body = (cb[2] ?? "").trim();
    if (mark === "x" || mark === "X") return "done";
    if (mark === "/" || mark === "~" || mark === "-") return "in_progress";
    if (mark === "!") return "blocked";
    if (/\bBLOCKED\b|阻塞|🔴/iu.test(body)) return "blocked";
    return "todo";
  }
  const hasDelivCode = DELIV_CODE_RE.test(body);
  if (body.includes("✅")) return "done";
  if (body.includes("🚧") || body.includes("🔄")) return "in_progress";
  if (body.includes("🔴") || /\bBLOCKED\b|阻塞/i.test(body)) return "blocked";
  if (hasDelivCode) return "todo";
  return null;
}

function evaluateSectionLines(lines: readonly string[]): {
  done: number;
  inProgress: number;
  todo: number;
  blocked: number;
  codeDone: number;
  codeTotal: number;
  realDone: number;
  realTotal: number;
  hasExitGate: boolean;
} {
  let done = 0;
  let inProgress = 0;
  let todo = 0;
  let blocked = 0;
  let codeDone = 0;
  let codeTotal = 0;
  let realDone = 0;
  let realTotal = 0;
  let hasExitGate = false;

  const listItemRe = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
  const indents: number[] = [];
  let hasDelivHeader = false;
  for (const ln of lines) {
    const m = listItemRe.exec(ln);
    if (!m) continue;
    indents.push((m[1] ?? "").length);
    if (DELIVERABLE_HEADER_RE.test((m[2] ?? "").trim())) hasDelivHeader = true;
  }
  const topIndent = indents.length > 0 ? Math.min(...indents) : 0;

  let mode: "scan" | "deliverables" | "entry_gate" | "exit_gate" = "scan";
  let modeIndent = -1;

  for (const ln of lines) {
    const stripped = ln.trim();
    if (!stripped) continue;
    if (/<!--\s*ops:gate\s+[^>]*exit=/i.test(stripped)) {
      hasExitGate = true;
      continue;
    }
    const m = listItemRe.exec(ln);
    if (!m) {
      if (EXIT_GATE_RE.test(stripped)) hasExitGate = true;
      continue;
    }
    const indent = (m[1] ?? "").length;
    const body = (m[2] ?? "").trim();
    if (mode !== "scan" && indent <= modeIndent) {
      mode = "scan";
      modeIndent = -1;
    }
    if (DELIVERABLE_HEADER_RE.test(body)) {
      mode = "deliverables";
      modeIndent = indent;
      continue;
    }
    if (ENTRY_GATE_RE.test(body)) {
      mode = "entry_gate";
      modeIndent = indent;
      continue;
    }
    if (EXIT_GATE_RE.test(body)) {
      mode = "exit_gate";
      modeIndent = indent;
      hasExitGate = true;
      continue;
    }
    if (mode === "entry_gate") continue;
    if (mode === "exit_gate") {
      hasExitGate = true;
      continue;
    }
    if (hasDelivHeader && mode !== "deliverables") continue;
    if (!hasDelivHeader && (indent > topIndent + 1 || META_BULLET_RE.test(body))) continue;

    const st = classifyRoadmapBulletItem(body);
    if (st) {
      const isReal = /\[(?:我|等外部|观察窗)(?:[·:\s]+[^\]\n]+)?\]/.test(body);
      if (isReal) {
        realTotal += 1;
        if (st === "done") realDone += 1;
      } else {
        codeTotal += 1;
        if (st === "done") codeDone += 1;
      }
    }
    if (st === "done") done += 1;
    else if (st === "in_progress") inProgress += 1;
    else if (st === "blocked") blocked += 1;
    else if (st === "todo") todo += 1;
  }

  return { done, inProgress, todo, blocked, codeDone, codeTotal, realDone, realTotal, hasExitGate };
}

export function parseRepoRoadmapMarkdown(markdown: string): ParsedRepoRoadmap {
  const normalized = markdown.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const rawSections: RawRoadmapSection[] = [];
  let inFence = false;

  for (const line of normalized.split("\n")) {
    if (/^\s{0,3}(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const hm = /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (hm?.[1] && hm[2]) {
      rawSections.push({ level: hm[1].length, rawHeading: hm[2].trim(), lines: [] });
    } else if (rawSections.length > 0) {
      rawSections[rawSections.length - 1]!.lines.push(line);
    }
  }

  const hasExplicitStageHeadings = rawSections.some(
    (s) => s.level >= 2 && splitRoadmapHeadingCodeAndTitle(s.rawHeading).isStageHeading,
  );

  const stages: EvaluatedRoadmapStage[] = [];
  for (let idx = 0; idx < rawSections.length; idx += 1) {
    const sec = rawSections[idx]!;
    if (sec.level < 2) continue;
    const parsedHead = splitRoadmapHeadingCodeAndTitle(sec.rawHeading);
    if (hasExplicitStageHeadings && !parsedHead.isStageHeading) continue;

    const combinedLines = [...sec.lines];
    if (hasExplicitStageHeadings) {
      for (let j = idx + 1; j < rawSections.length; j += 1) {
        const nxt = rawSections[j]!;
        if (nxt.level <= sec.level) break;
        if (splitRoadmapHeadingCodeAndTitle(nxt.rawHeading).isStageHeading) break;
        combinedLines.push(...nxt.lines);
      }
    }

    const counts = evaluateSectionLines(combinedLines);
    const secTotal = counts.done + counts.inProgress + counts.todo + counts.blocked;
    if (!hasExplicitStageHeadings && secTotal === 0) continue;

    const explicitActive = isExplicitActiveRoadmapHeading(sec.rawHeading);
    let status = "planned";
    if (counts.blocked > 0) {
      status = "blocked";
    } else if (counts.codeTotal > 0 && counts.codeDone === counts.codeTotal && counts.realTotal > 0 && counts.realDone < counts.realTotal) {
      status = "monitoring";
    } else if (explicitActive) {
      status = secTotal > 0 && counts.done === secTotal && counts.hasExitGate ? "monitoring" : "in_progress";
    } else if (secTotal > 0 && counts.done === secTotal) {
      status = "completed";
    } else if (counts.inProgress > 0) {
      status = "in_progress";
    }

    stages.push({
      ...(parsedHead.code ? { code: parsedHead.code } : {}),
      title: parsedHead.title,
      isStageHeading: parsedHead.isStageHeading,
      explicitActive,
      hasExitGate: counts.hasExitGate,
      done: counts.done,
      inProgress: counts.inProgress,
      todo: counts.todo,
      blocked: counts.blocked,
      codeDone: counts.codeDone,
      codeTotal: counts.codeTotal,
      realDone: counts.realDone,
      realTotal: counts.realTotal,
      status,
    });
  }

  const totalDone = stages.reduce((acc, s) => acc + s.done, 0);
  const grandTotal = stages.reduce((acc, s) => acc + s.done + s.inProgress + s.todo + s.blocked, 0);
  const totalCodeDone = stages.reduce((acc, s) => acc + s.codeDone, 0);
  const totalCodeTotal = stages.reduce((acc, s) => acc + s.codeTotal, 0);
  const totalRealDone = stages.reduce((acc, s) => acc + s.realDone, 0);
  const totalRealTotal = stages.reduce((acc, s) => acc + s.realTotal, 0);
  const totals = {
    done: totalDone,
    total: grandTotal,
    pct: grandTotal > 0 ? Math.round((totalDone / grandTotal) * 100) : 0,
    ...(totalRealTotal > 0 ? { codeDone: totalCodeDone, codeTotal: totalCodeTotal, realDone: totalRealDone, realTotal: totalRealTotal } : {}),
  };

  const nonEmptyStages = stages.filter((s) => s.done + s.inProgress + s.todo + s.blocked > 0);
  if (nonEmptyStages.length === 0) return { totals };

  let chosen =
    nonEmptyStages.find((s) => s.explicitActive && (s.status === "monitoring" || s.status === "in_progress" || s.status === "blocked")) ??
    nonEmptyStages.find((s) => s.status === "blocked" || s.status === "in_progress" || s.status === "monitoring");

  if (!chosen) {
    const firstOpen = nonEmptyStages.find((s) => s.status === "planned" && s.todo > 0);
    if (firstOpen) {
      firstOpen.status = "in_progress";
      chosen = firstOpen;
    } else {
      chosen = nonEmptyStages[nonEmptyStages.length - 1];
    }
  }
  if (!chosen) return { totals };

  const chosenTotal = chosen.done + chosen.inProgress + chosen.todo + chosen.blocked;
  return {
    activeNode: {
      ...(chosen.code ? { code: chosen.code } : {}),
      title: chosen.title,
      status: chosen.status,
      progress: {
        done: chosen.done,
        total: chosenTotal,
        pct: chosenTotal > 0 ? Math.round((chosen.done / chosenTotal) * 100) : 0,
        ...(chosen.realTotal > 0
          ? { codeDone: chosen.codeDone, codeTotal: chosen.codeTotal, realDone: chosen.realDone, realTotal: chosen.realTotal }
          : {}),
      },
      ...(chosen.inProgress > 0 ? { inProgressCount: chosen.inProgress } : {}),
      ...(chosen.todo > 0 ? { todoCount: chosen.todo } : {}),
      ...(chosen.blocked > 0 ? { blockedCount: chosen.blocked } : {}),
      ...(chosen.hasExitGate ? { hasExitGate: true } : {}),
    },
    totals,
  };
}

function deriveProjectKeyFromRepo(repoDir: string, nodeId: string): string {
  try {
    const opsProjPath = path.join(repoDir, ".ops-project.json");
    if (fs.existsSync(opsProjPath)) {
      const parsed = JSON.parse(fs.readFileSync(opsProjPath, "utf8")) as { projectKey?: unknown };
      if (typeof parsed?.projectKey === "string" && parsed.projectKey.trim()) {
        return parsed.projectKey.trim().toLowerCase();
      }
    }
  } catch {
    // ignore malformed .ops-project.json
  }
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

function uriToNormalizedFsPath(rawUri: string): string {
  const trimmed = String(rawUri ?? "").trim();
  if (!trimmed) return "";
  let fsPath = trimmed;
  if (fsPath.startsWith("file://")) {
    try {
      fsPath = decodeURIComponent(new URL(fsPath).pathname);
    } catch {
      fsPath = decodeURIComponent(fsPath.slice("file://".length));
    }
  }
  return fsPath ? path.resolve(fsPath) : "";
}

function loadKanbanHomeMetadata(homeDir: string): {
  registeredNames: Map<string, string>;
  sidecarsByFolder: Map<string, { hasSidecar: boolean; hasError: boolean }>;
} {
  const registeredNames = new Map<string, string>();
  const sidecarsByFolder = new Map<string, { hasSidecar: boolean; hasError: boolean }>();
  const dotGem = "." + "ge" + "mini";
  const projCfgDir = path.join(homeDir, dotGem, "config", "projects");
  try {
    if (fs.existsSync(projCfgDir)) {
      for (const fn of fs.readdirSync(projCfgDir).sort()) {
        if (!fn.endsWith(".json")) continue;
        try {
          const obj = JSON.parse(fs.readFileSync(path.join(projCfgDir, fn), "utf8")) as {
            name?: unknown;
            sidecar?: unknown;
            projectResources?: { resources?: Array<{ folderUri?: unknown; gitFolder?: { folderUri?: unknown } }> };
          };
          const name = typeof obj.name === "string" ? obj.name.trim() : "";
          const isAux = Boolean(obj.sidecar) || /-(?:review|sidecar|cron|daily|timer)$/i.test(name);
          for (const res of obj.projectResources?.resources ?? []) {
            const rawUri =
              typeof res.gitFolder?.folderUri === "string"
                ? res.gitFolder.folderUri
                : typeof res.folderUri === "string"
                  ? res.folderUri
                  : "";
            const resolved = uriToNormalizedFsPath(rawUri);
            if (!resolved) continue;
            const candidateName = name || path.basename(resolved);
            if (!registeredNames.has(resolved) || !isAux) {
              registeredNames.set(resolved, candidateName);
            }
          }
        } catch {
          // ignore single malformed project file
        }
      }
    }
  } catch {
    // ignore unreadable projects dir
  }

  const sidecarCfgDir = path.join(homeDir, dotGem, "config", "sidecars");
  const sidecarDataDir = path.join(homeDir, dotGem, "antigravity", "sidecar_data");
  try {
    if (fs.existsSync(sidecarCfgDir)) {
      for (const name of fs.readdirSync(sidecarCfgDir).sort()) {
        const cfgPath = path.join(sidecarCfgDir, name, "sidecar.json");
        if (!fs.existsSync(cfgPath)) continue;
        try {
          const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as {
            agent_permissions?: { workspace_uris?: unknown[] };
          };
          const uris = Array.isArray(cfg.agent_permissions?.workspace_uris) ? cfg.agent_permissions.workspace_uris : [];
          let targetFolder = "";
          for (const u of uris) {
            const cand = uriToNormalizedFsPath(String(u ?? ""));
            if (cand) {
              targetFolder = cand;
              break;
            }
          }
          if (!targetFolder) continue;
          let hasError = false;
          const evDir = path.join(sidecarDataDir, name, "events");
          if (fs.existsSync(evDir)) {
            const evFiles = fs.readdirSync(evDir).filter((f) => f.endsWith(".json")).sort();
            const latestEv = evFiles[evFiles.length - 1];
            if (latestEv) {
              const ev = JSON.parse(fs.readFileSync(path.join(evDir, latestEv), "utf8")) as { error?: unknown };
              hasError = Boolean(ev?.error);
            }
          }
          const prev = sidecarsByFolder.get(targetFolder);
          sidecarsByFolder.set(targetFolder, { hasSidecar: true, hasError: Boolean(prev?.hasError || hasError) });
        } catch {
          // ignore malformed sidecar file
        }
      }
    }
  } catch {
    // ignore unreadable sidecars dir
  }

  return { registeredNames, sidecarsByFolder };
}

function inferKanbanDomain(projectKey: string, displayName: string): string {
  const identity = `${projectKey} ${displayName}`.toLowerCase();
  if (/(?:token|wallet|quant|trading|alpha|backtest|factor|portfolio|crypto|量化|实盘|交易|策略|账本|钱包)/i.test(identity)) {
    return "quant_trading";
  }
  if (/(?:gcp|script|transcri|audio|fleet|infra|devops|daemon|hook|lavoisier|tesla|工具|脚本|底座|转录|运维)/i.test(identity)) {
    return "infra_tools";
  }
  if (/(?:lean|cowork|fde|consult|client|bom|\.com\.cn|advisory|商业|咨询|交付|客户|清单)/i.test(identity) || /(?:^|[-_/:.\s])eto(?:$|[-_/:.\s])/i.test(identity)) {
    return "client_consulting";
  }
  if (/(?:ppt|slide|remotion|motion|video|shorts|printer|design|creation|content|brand|课题|大赛|内容|品牌|视频|视觉|海报|课件)/i.test(identity)) {
    return "content_brand";
  }
  return "ai_products";
}

function inferKanbanStageAndBoardStatus(params: {
  domain: string;
  hasStatusMd: boolean;
  parsedStatus?: ParsedRepoStatus;
  parsedRoadmap?: ParsedRepoRoadmap;
  hasGovernanceAnchor: boolean;
  isRegistered: boolean;
  hasSidecar: boolean;
  sidecarHasError: boolean;
  runningCount: number;
  recentSteps72h: number;
  lastActiveMs: number;
  nowMs: number;
}): { stage: string; boardStatus: string; boardStatusReason: string } {
  const ageDays = params.lastActiveMs > 0 ? Math.max(0, (params.nowMs - params.lastActiveMs) / 86_400_000) : Number.POSITIVE_INFINITY;
  const isRunning = params.runningCount > 0;
  const pureAutopilot = params.hasSidecar && params.recentSteps72h < 200 && !isRunning;

  let stage = "incubating";
  if (pureAutopilot) {
    stage = "autopilot";
  } else if (ageDays > 21 && !isRunning && params.recentSteps72h === 0) {
    stage = "archived";
  } else if (params.domain === "infra_tools" && ageDays <= 14 && params.recentSteps72h < 30 && !isRunning) {
    stage = "autopilot";
  } else {
    const openTodos = (params.parsedRoadmap?.totals.total ?? 0) - (params.parsedRoadmap?.totals.done ?? 0);
    const hasTraction = params.hasGovernanceAnchor || params.hasStatusMd || params.recentSteps72h >= 15 || isRunning || openTodos > 0;
    if (hasTraction && (ageDays <= 10 || isRunning || params.recentSteps72h >= 15 || params.parsedRoadmap?.activeNode?.status === "monitoring")) {
      stage = "focus";
    }
  }
  if (stage === "focus" && !isRunning && !params.hasStatusMd && !params.hasGovernanceAnchor && !params.isRegistered) {
    stage = "incubating";
  }

  const blockers = params.parsedStatus?.blockers ?? [];
  if (blockers.length > 0) {
    return { stage, boardStatus: "blocked", boardStatusReason: `STATUS.md 存在卡点：${blockers[0]!.slice(0, 40)}` };
  }
  if (params.sidecarHasError) {
    return { stage, boardStatus: "blocked", boardStatusReason: "后台定时巡检报错" };
  }
  if ((params.parsedRoadmap?.activeNode?.blockedCount ?? 0) > 0) {
    return { stage, boardStatus: "blocked", boardStatusReason: "路线图活跃节点存在阻塞项" };
  }

  const reviewState = params.hasStatusMd ? (params.parsedStatus?.reviewState || "pending_review") : "untracked";
  if (reviewState === "pending_review") {
    return { stage, boardStatus: "pending_review", boardStatusReason: "STATUS.md 待主人确认验收" };
  }

  if (isRunning) {
    return { stage, boardStatus: "active_executing", boardStatusReason: "当前存在活跃运行中的会话" };
  }

  const inflightWindowMs = 72 * 3_600_000;
  const statusUpdatedMs = parseIsoMs(params.parsedStatus?.updatedAt);
  const hasFreshInflight = (params.parsedStatus?.inflight ?? []).some((it) => {
    if (!it.text?.trim()) return false;
    const ts = parseIsoMs(it.updatedAt) || statusUpdatedMs;
    return ts <= 0 || params.nowMs - ts <= inflightWindowMs;
  });
  if (hasFreshInflight) {
    return { stage, boardStatus: "active_executing", boardStatusReason: "存在 72h 内在途任务" };
  }
  if ((params.parsedRoadmap?.activeNode?.inProgressCount ?? 0) > 0) {
    return { stage, boardStatus: "active_executing", boardStatusReason: "路线图活跃节点存在进行中交付项" };
  }

  if (params.parsedRoadmap?.activeNode?.status === "monitoring") {
    const label = params.parsedRoadmap.activeNode.code || "当前阶段";
    return { stage, boardStatus: "monitoring", boardStatusReason: `${label} 交付已齐，处于门禁观测期` };
  }
  if (stage === "autopilot" && !params.sidecarHasError) {
    return { stage, boardStatus: "monitoring", boardStatusReason: "后台常驻巡检健康运行中" };
  }

  const hasNext = (params.parsedStatus?.nextActions.length ?? 0) > 0;
  const hasTodo = (params.parsedRoadmap?.totals.total ?? 0) - (params.parsedRoadmap?.totals.done ?? 0) > 0;
  if (stage !== "archived" && reviewState === "confirmed" && (hasNext || hasTodo) && ageDays <= 21) {
    return { stage, boardStatus: "planned_ready", boardStatusReason: "状态已确认且有明确下一步排期" };
  }

  const idleReason =
    stage === "archived"
      ? "项目已归档"
      : reviewState === "untracked"
        ? "尚未建立 STATUS.md 档案"
        : "暂无近期在途或后续排期";
  return { stage, boardStatus: "idle_untracked", boardStatusReason: idleReason };
}

const KANBAN_LANE_ORDER: Record<string, number> = {
  blocked: 1,
  active_executing: 2,
  pending_review: 3,
  monitoring: 4,
  planned_ready: 5,
  idle_untracked: 6,
};

const KANBAN_STAGE_ORDER: Record<string, number> = {
  focus: 1,
  autopilot: 2,
  incubating: 3,
  archived: 4,
};

export function scanLocalProjectsForEdge(opts: ScanLocalProjectsForEdgeOptions): EdgeProjectPulseItem[] {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const nowMs = parseIsoMs(nowIso) || Date.now();
  const defaultTier: EdgePrivacyTier = opts.defaultTier ?? 2;
  const maxProjects = Math.max(1, opts.maxProjects ?? 200);
  const candidateDirs: string[] = [];
  const seenRealPaths = new Set<string>();

  const addCandidate = (dirPath: string): void => {
    if (!dirPath || !fs.existsSync(dirPath)) return;
    try {
      if (!fs.statSync(dirPath).isDirectory()) return;
    } catch {
      return;
    }
    const resolved = path.resolve(dirPath);
    if (seenRealPaths.has(resolved)) return;
    seenRealPaths.add(resolved);
    candidateDirs.push(resolved);
  };

  const kanbanMeta = opts.homeDir ? loadKanbanHomeMetadata(opts.homeDir) : undefined;
  const sessionWorkspaceSet = new Set<string>();
  for (const s of opts.sessions ?? []) {
    const rawCandidates = [s.workspaceRoot, ...(s.workspaceUris ?? [])].filter((x): x is string => Boolean(x));
    for (const rawWs of rawCandidates) {
      if (/(?:^|\/)worktrees\/|\/subagents\//.test(rawWs.replace(/\\/g, "/"))) continue;
      const norm = uriToNormalizedFsPath(rawWs);
      if (norm && fs.existsSync(norm)) sessionWorkspaceSet.add(norm);
    }
  }

  if (opts.homeDir && kanbanMeta) {
    for (const regDir of kanbanMeta.registeredNames.keys()) addCandidate(regDir);
    for (const scDir of kanbanMeta.sidecarsByFolder.keys()) addCandidate(scDir);
    for (const sessDir of sessionWorkspaceSet) addCandidate(sessDir);
    for (const wellKnown of [
      path.join(opts.homeDir, "Documents", "Lean-Digital"),
      path.join(opts.homeDir, "Wallet-management"),
      path.join(opts.homeDir, "Projects", "agy-fleet-config"),
      path.join("/", "opt", "airtoken"),
    ]) {
      addCandidate(wellKnown);
    }
    for (const rootDir of opts.projectsRootDirs) {
      if (!rootDir || !fs.existsSync(rootDir)) continue;
      const selfExplicit =
        fs.existsSync(path.join(rootDir, "STATUS.md")) ||
        fs.existsSync(path.join(rootDir, ".ops-project.json"));
      if (selfExplicit) {
        addCandidate(rootDir);
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
        const fullPath = path.resolve(path.join(rootDir, ent.name));
        const isManaged =
          kanbanMeta.registeredNames.has(fullPath) ||
          kanbanMeta.sidecarsByFolder.has(fullPath) ||
          sessionWorkspaceSet.has(fullPath) ||
          fs.existsSync(path.join(fullPath, "STATUS.md")) ||
          fs.existsSync(path.join(fullPath, ".ops-project.json"));
        if (isManaged) addCandidate(fullPath);
      }
    }
  } else {
    for (const rootDir of opts.projectsRootDirs) {
      if (!rootDir || !fs.existsSync(rootDir)) continue;
      const selfHasMarker =
        fs.existsSync(path.join(rootDir, ".git")) ||
        fs.existsSync(path.join(rootDir, "STATUS.md")) ||
        fs.existsSync(path.join(rootDir, ".ops-project.json")) ||
        fs.existsSync(path.join(rootDir, "package.json"));
      if (selfHasMarker) {
        addCandidate(rootDir);
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
          fs.existsSync(path.join(fullPath, ".ops-project.json")) ||
          fs.existsSync(path.join(fullPath, "package.json"));
        if (hasMarker) addCandidate(fullPath);
      }
    }
  }

  const out: EdgeProjectPulseItem[] = [];
  for (const repoDir of candidateDirs) {
    const rawKey = deriveProjectKeyFromRepo(repoDir, opts.nodeId);
    const tier = opts.resolveTier ? opts.resolveTier(rawKey, repoDir) : defaultTier;
    const displayName = kanbanMeta?.registeredNames.get(repoDir) || path.basename(repoDir);

    const matchingSessions = (opts.sessions ?? []).filter(
      (s) => s.projectKey === rawKey || (s.workspaceRoot && path.resolve(s.workspaceRoot) === repoDir),
    );
    const runningSessions = matchingSessions.filter((s) => s.isRunning);
    const latestSessionMs = matchingSessions.reduce((mx, s) => Math.max(mx, s.lastModifiedMs ?? 0), 0);
    const recentSteps72h = matchingSessions
      .filter((s) => (s.lastModifiedMs ?? 0) >= nowMs - 72 * 3_600_000)
      .reduce((sum, s) => sum + (s.stepCount || 0), 0);

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
    let hasStatusMd = false;
    const statusMdPath = path.join(repoDir, "STATUS.md");
    if (fs.existsSync(statusMdPath)) {
      try {
        parsedStatus = parseRepoStatusMarkdown(fs.readFileSync(statusMdPath, "utf8"));
        hasStatusMd = Boolean(parsedStatus.stageGoal || parsedStatus.landed.length || parsedStatus.nextActions.length || parsedStatus.reviewState);
      } catch {
        parsedStatus = undefined;
      }
    }

    let parsedRoadmap: ParsedRepoRoadmap | undefined;
    const roadmapCandidates = [
      path.join(repoDir, "ROADMAP.md"),
      path.join(repoDir, "docs", "ROADMAP.md"),
      path.join(repoDir, "roadmap.md"),
      path.join(repoDir, "docs", "roadmap.md"),
    ];
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

    const hasGovernanceAnchor =
      Boolean(parsedRoadmap) ||
      ["ROADMAP.md", "TASKS.md", "TOMBSTONES.md", "PROJECT.md", ".agents"].some((anc) =>
        fs.existsSync(path.join(repoDir, anc)),
      );
    const sidecarInfo = kanbanMeta?.sidecarsByFolder.get(repoDir);
    const domain = inferKanbanDomain(rawKey, displayName);
    const lastActiveMs = Math.max(latestSessionMs, parseIsoMs(parsedStatus?.updatedAt));
    const lastActiveIso = lastActiveMs > 0 ? new Date(lastActiveMs).toISOString() : (parsedStatus?.updatedAt || nowIso);

    const { stage, boardStatus, boardStatusReason } = inferKanbanStageAndBoardStatus({
      domain,
      hasStatusMd,
      ...(parsedStatus ? { parsedStatus } : {}),
      ...(parsedRoadmap ? { parsedRoadmap } : {}),
      hasGovernanceAnchor,
      isRegistered: Boolean(kanbanMeta?.registeredNames.has(repoDir)),
      hasSidecar: Boolean(sidecarInfo?.hasSidecar),
      sidecarHasError: Boolean(sidecarInfo?.hasError),
      runningCount: runningSessions.length,
      recentSteps72h,
      lastActiveMs,
      nowMs,
    });

    const sanitizedGoal = parsedStatus?.stageGoal
      ? redactLocalPaths(parsedStatus.stageGoal)
      : parsedRoadmap?.activeNode
        ? redactLocalPaths(`${parsedRoadmap.activeNode.code ? `${parsedRoadmap.activeNode.code} ` : ""}${parsedRoadmap.activeNode.title}`.trim())
        : undefined;

    if (tier === 1) {
      out.push({
        projectKey: rawKey,
        displayName: redactLocalPaths(displayName),
        nodeId: opts.nodeId,
        nodes: [opts.nodeId],
        tier: 1,
        privacyTier: 1,
        domain,
        stage,
        boardStatus,
        boardStatusReason,
        status: runningSessions.length > 0 ? "running" : "idle",
        updatedAtIso: lastActiveIso,
        lastActiveAt: lastActiveIso,
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
      domain,
      stage,
      boardStatus,
      boardStatusReason,
      status: runningSessions.length > 0 ? "running" : "idle",
      ...(summaryParts.length > 0 ? { sanitizedSummary: summaryParts.join(" · ").slice(0, 280) } : {}),
      updatedAtIso: lastActiveIso,
      lastActiveAt: lastActiveIso,
      ...(parsedStatus || runningSessions.length > 0 || sanitizedGoal
        ? {
            statusCard: {
              ...(sanitizedGoal ? { stageGoal: sanitizedGoal } : {}),
              landed,
              inflight,
              nextActions,
              blockers,
              reviewState: hasStatusMd ? (parsedStatus?.reviewState ?? "pending_review") : "untracked",
              ...(parsedStatus?.updatedBy ? { updatedBy: redactLocalPaths(parsedStatus.updatedBy) } : {}),
              updatedAt: parsedStatus?.updatedAt || lastActiveIso,
              source: hasStatusMd ? "status_md" : (parsedRoadmap ? "roadmap" : "workspace"),
            },
            executiveSummary: {
              ...(sanitizedGoal ? { goalText: sanitizedGoal } : {}),
              ...(landed[0] ? { progressText: landed[0] } : {}),
              ...(nextActions[0] ? { nextActionText: nextActions[0] } : {}),
              updatedAt: parsedStatus?.updatedAt || lastActiveIso,
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

  out.sort(
    (a, b) =>
      Number(b.status === "running") - Number(a.status === "running") ||
      (KANBAN_LANE_ORDER[a.boardStatus ?? "idle_untracked"] ?? 6) - (KANBAN_LANE_ORDER[b.boardStatus ?? "idle_untracked"] ?? 6) ||
      (KANBAN_STAGE_ORDER[a.stage ?? "incubating"] ?? 3) - (KANBAN_STAGE_ORDER[b.stage ?? "incubating"] ?? 3) ||
      (parseIsoMs(b.lastActiveAt ?? b.updatedAtIso) - parseIsoMs(a.lastActiveAt ?? a.updatedAtIso)),
  );

  return out.slice(0, maxProjects);
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
                ? "active_executing"
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
          (KANBAN_LANE_ORDER[a.boardStatus ?? "idle_untracked"] ?? 6) - (KANBAN_LANE_ORDER[b.boardStatus ?? "idle_untracked"] ?? 6) ||
          (KANBAN_STAGE_ORDER[a.stage ?? "incubating"] ?? 3) - (KANBAN_STAGE_ORDER[b.stage ?? "incubating"] ?? 3) ||
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

  private formatFetchError(err: unknown): string {
    const e = err as Error & { cause?: { code?: string; message?: string } };
    const base = e?.message || String(err);
    const code = e?.cause?.code ? `[${e.cause.code}] ` : "";
    const detail = e?.cause?.message && e.cause.message !== base ? ` (${e.cause.message})` : "";
    return redactLocalPaths(`${code}${base}${detail}`).slice(0, 280);
  }

  async runCycleOnce(): Promise<EdgeTentacleRunnerCycleResult> {
    const errors: string[] = [];
    const sessions = this.opts.scanSessions ? this.opts.scanSessions() : [];
    const projects = scanLocalProjectsForEdge({
      projectsRootDirs: this.projectsRootDirs,
      ...(this.opts.homeDir ? { homeDir: this.opts.homeDir } : {}),
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
      errors.push(`PULSE_ERR:${this.formatFetchError(e)}`);
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
            errors.push(`ACK_ERR:${this.formatFetchError(ackErr)}`);
          });
        }
      }
    } catch (e) {
      errors.push(`PULL_ERR:${this.formatFetchError(e)}`);
    }

    const result: EdgeTentacleRunnerCycleResult = {
      pulseOk,
      projectCount: projects.length,
      commandsExecuted,
      errors,
    };
    this.opts.onCycle?.(result);
    return result;
  }

  async runOnce() {
    return this.runCycleOnce();
  }

  start(opts?: { keepAlive?: boolean }): void {
    if (this.timer) return;
    void this.runCycleOnce().catch(() => {});
    this.timer = setInterval(() => {
      void this.runCycleOnce().catch(() => {});
    }, this.intervalMs);
    if (!opts?.keepAlive) {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
