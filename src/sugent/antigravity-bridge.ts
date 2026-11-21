/**
 * Sugent ↔ Antigravity 多表面状态感知、跨端脉冲消费、动态隐私门禁与独立插件钩子
 *
 * 严格遵循只读/零侵入原则：
 * - SQLite 一律通过 `file:<path>?mode=ro` + `{ readOnly: true }` 打开，不写入 Antigravity 库；
 * - 插件钩子独立写入 `<pluginsRoot>/sugent-steward/{plugin.json,hooks.json}`，严禁覆盖全局软链；
 * - 不硬编码任何私人网站名或私人项目名，跨模块仅导出无冲突 `BridgeFleetCadenceEvent`。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { looksSecret } from "../agent/memory.js";
import {
  PersonalSourceRegistry,
  ZeroTokenProbeTracker,
  type ZeroTokenProbeDecision,
} from "./sources.js";
import type { PersonalTrigger } from "./types.js";

export type AntigravitySurface = "app" | "cli" | "ide";
export type AntigravitySessionRole = "interactive" | "readonly-sidecar" | "subagent";

export type BridgeFleetCadenceKind =
  | "red_collision"
  | "node_or_sidecar_error"
  | "pending_handoff"
  | "review_ready";

export interface BridgeFleetCadenceEvent {
  id: string;
  dedupeKey: string;
  kind: BridgeFleetCadenceKind;
  projectKey: string;
  nodeId: string;
  summary: string;
  actionHint: string;
  urgency: "normal" | "urgent";
  conversationId?: string;
  superseded?: boolean;
  updatedAtIso: string;
}

export type PrivacyTier = 0 | 1 | 2;
export type PrivacyTierSource = "heuristic" | "user_override";

export interface ProjectPrivacyPolicy {
  projectKey: string;
  tier: PrivacyTier;
  tierSource: PrivacyTierSource;
  tierEpoch: number;
  registered: boolean;
  reason: string;
  updatedAt: string;
}

export interface SanitizedTierPayloadResult {
  allowed: boolean;
  rejected: boolean;
  staleEpoch: boolean;
  tier: PrivacyTier;
  tierEpoch: number;
  strippedFields: string[];
  sanitized: Record<string, unknown>;
  reason?: string;
}

export function parseAntigravityTimestampMs(input: string | number | null | undefined): number | undefined {
  if (typeof input === "number") return Number.isFinite(input) ? input : undefined;
  if (typeof input !== "string") return undefined;
  const trimmed = input.trim();
  if (!trimmed) return undefined;

  const pbMatch = /last_user_view_time\s*:\s*\{[^}]*?seconds\s*:\s*(\d+)(?:[^}]*?nanos\s*:\s*(\d+))?[^}]*\}/s.exec(
    trimmed,
  );
  if (pbMatch) {
    const seconds = Number(pbMatch[1]);
    const nanos = Number(pbMatch[2] ?? "0");
    return Number.isFinite(seconds) && Number.isFinite(nanos)
      ? seconds * 1000 + Math.floor(nanos / 1_000_000)
      : undefined;
  }

  const dtMatch = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/i.exec(trimmed);
  if (dtMatch) {
    const frac = dtMatch[3] ? `.${dtMatch[3].slice(0, 3).padEnd(3, "0")}` : "";
    let tz = dtMatch[4] ?? "Z";
    if (/^[+-]\d{4}$/.test(tz)) tz = `${tz.slice(0, 3)}:${tz.slice(3)}`;
    const ms = Date.parse(`${dtMatch[1]}T${dtMatch[2]}${frac}${tz}`);
    return Number.isFinite(ms) ? ms : undefined;
  }

  const fallbackMs = Date.parse(trimmed);
  return Number.isFinite(fallbackMs) ? fallbackMs : undefined;
}

export function isSubagentSession(input: {
  cwd?: string;
  transcriptPath?: string;
  nestingDepth?: number;
}): boolean {
  if (typeof input.nestingDepth === "number" && Number.isFinite(input.nestingDepth) && input.nestingDepth > 0) {
    return true;
  }
  const paths = [input.cwd, input.transcriptPath];
  for (const raw of paths) {
    if (typeof raw !== "string" || !raw) continue;
    const norm = raw.replace(/\\/g, "/");
    if (/(?:^|\/)(?:worktrees|subagents)(?:\/|$)/.test(norm)) {
      return true;
    }
  }
  return false;
}

function stripFileUriPrefix(rawUriOrPath: string): string {
  const trimmed = rawUriOrPath.trim();
  if (!trimmed) return "";
  let fsPath = trimmed;
  if (trimmed.startsWith("file://")) {
    try {
      fsPath = fileURLToPath(trimmed);
    } catch {
      fsPath = decodeURIComponent(trimmed.slice("file://".length));
    }
  }
  const slashed = fsPath.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  return slashed.length > 1 ? slashed.replace(/\/+$/, "") : slashed;
}

function resolveGitWorktreeMainRoot(worktreeDir: string): string | undefined {
  try {
    const dotGitPath = path.join(worktreeDir, ".git");
    if (!fs.existsSync(dotGitPath) || !fs.statSync(dotGitPath).isFile()) return undefined;
    const raw = fs.readFileSync(dotGitPath, "utf8");
    const m = /^\s*gitdir:\s*(.+?)\s*$/m.exec(raw);
    if (!m?.[1]) return undefined;
    const resolvedGitDir = path.resolve(worktreeDir, m[1]).replace(/\\/g, "/");
    const idx = resolvedGitDir.indexOf("/.git/worktrees/");
    return idx > 0 ? resolvedGitDir.slice(0, idx) : undefined;
  } catch {
    return undefined;
  }
}

export interface WorkspaceRootInspection {
  rootPath: string;
  isIsolatedWorktree: boolean;
  worktreeConversationId?: string;
}

export function inspectWorkspaceRoot(rawUriOrPath: string): WorkspaceRootInspection {
  const cleaned = stripFileUriPrefix(rawUriOrPath);
  if (!cleaned) return { rootPath: "", isIsolatedWorktree: false };

  const agyMatch = /^(.*?\/\.gemini\/antigravity(?:-cli|-ide)?)\/worktrees\/([^/]+)(?:\/([^/]+))?(?:\/.*)?$/.exec(
    cleaned,
  );
  if (agyMatch) {
    const convId = agyMatch[2]!;
    const sub = agyMatch[3];
    const worktreeDir = sub ? `${agyMatch[1]}/worktrees/${convId}/${sub}` : `${agyMatch[1]}/worktrees/${convId}`;
    const resolvedMain = resolveGitWorktreeMainRoot(worktreeDir);
    if (resolvedMain) {
      return { rootPath: resolvedMain, isIsolatedWorktree: true, worktreeConversationId: convId };
    }
    return {
      rootPath: `isolated-worktree:${convId}${sub ? `/${sub}` : ""}`,
      isIsolatedWorktree: true,
      worktreeConversationId: convId,
    };
  }

  const repoWtMatch = /^(.+?)\/(?:\.git\/)?worktrees\/([^/]+)(?:\/swarm-[^/]+)?(?:\/.*)?$/.exec(cleaned);
  if (repoWtMatch) {
    return { rootPath: repoWtMatch[1]!, isIsolatedWorktree: true, worktreeConversationId: repoWtMatch[2] };
  }
  return { rootPath: cleaned, isIsolatedWorktree: false };
}

export function normalizeWorkspaceRoot(rawUriOrPath: string): string {
  return inspectWorkspaceRoot(rawUriOrPath).rootPath;
}

function readOpsProjectKey(folderPath?: string): string | undefined {
  if (!folderPath) return undefined;
  const candidates = [stripFileUriPrefix(folderPath), normalizeWorkspaceRoot(folderPath)].filter(
    (p) => Boolean(p) && !p.startsWith("isolated-worktree:"),
  );
  for (const dir of candidates) {
    try {
      const cfgPath = path.join(dir, ".ops-project.json");
      if (!fs.existsSync(cfgPath)) continue;
      const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as { projectKey?: unknown };
      if (typeof parsed?.projectKey === "string" && parsed.projectKey.trim()) {
        return parsed.projectKey.trim();
      }
    } catch {
      // Ignore malformed or unreadable .ops-project.json
    }
  }
  return undefined;
}

function readGitOriginUrl(workspaceRoot?: string): string | undefined {
  if (!workspaceRoot || workspaceRoot.startsWith("isolated-worktree:")) return undefined;
  try {
    const cfgPath = path.join(workspaceRoot, ".git", "config");
    if (!fs.existsSync(cfgPath)) return undefined;
    const raw = fs.readFileSync(cfgPath, "utf8");
    const originBlock = /\[remote\s+"origin"\]([\s\S]*?)(?:\n\[|$)/.exec(raw)?.[1];
    const urlMatch = originBlock ? /^\s*url\s*=\s*(.+?)\s*$/m.exec(originBlock) : undefined;
    return urlMatch?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function parseRemoteRepoSlug(remoteUrl: string): string | undefined {
  const trimmed = remoteUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return undefined;
  let repoPath = "";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    try {
      repoPath = new URL(trimmed).pathname;
    } catch {
      return undefined;
    }
  } else if (!/^[A-Za-z]:[\\/]/.test(trimmed)) {
    const scpMatch = /^(?:[^@:/\s]+@)?[^:/\s]+:(.+)$/.exec(trimmed);
    if (scpMatch?.[1]) repoPath = scpMatch[1];
  }
  const cleaned = repoPath.replace(/^\/+/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  const segments = cleaned.split("/").filter(Boolean);
  if (segments.length >= 2) {
    return `repo:${segments[segments.length - 2]!.toLowerCase()}/${segments[segments.length - 1]!.toLowerCase()}`;
  }
  if (segments.length === 1) {
    return `repo:${segments[0]!.toLowerCase()}`;
  }
  return undefined;
}

export function canonicalizeProjectKey(input: {
  remoteUrl?: string;
  explicitKey?: string;
  nodeId?: string;
  folderPath?: string;
}): string {
  const explicit = input.explicitKey?.trim();
  if (explicit) return explicit;
  const fromOpsFile = readOpsProjectKey(input.folderPath);
  if (fromOpsFile) return fromOpsFile;
  if (input.remoteUrl) {
    const parsedRepo = parseRemoteRepoSlug(input.remoteUrl);
    if (parsedRepo) return parsedRepo;
  }
  const cleanNode =
    (input.nodeId ?? "local-mac")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "local-mac";
  const normFolder = input.folderPath ? normalizeWorkspaceRoot(input.folderPath) : "";
  const rawBase = normFolder.startsWith("isolated-worktree:")
    ? normFolder.replace(/[:/]+/g, "-")
    : path.basename(normFolder);
  const slug =
    rawBase
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workspace";
  return `local:${cleanNode}:${slug}`;
}

export interface AntigravityProjectCatalogEntry {
  id: string;
  name: string;
  isSidecar: boolean;
}

export interface AntigravityProjectCatalog {
  byId: Map<string, AntigravityProjectCatalogEntry>;
  byFolder: Map<string, AntigravityProjectCatalogEntry>;
}

export function loadAntigravityProjectCatalog(homeDir: string): AntigravityProjectCatalog {
  const byId = new Map<string, AntigravityProjectCatalogEntry>();
  const byFolder = new Map<string, AntigravityProjectCatalogEntry>();
  const dir = path.join(homeDir, ".gemini", "config", "projects");
  try {
    if (!fs.existsSync(dir)) return { byId, byFolder };
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as {
          id?: unknown;
          name?: unknown;
          sidecar?: unknown;
          projectResources?: { resources?: Array<{ folderUri?: unknown; gitFolder?: { folderUri?: unknown } }> };
        };
        const id = typeof parsed.id === "string" ? parsed.id.trim() : "";
        const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
        if (!id || !name) continue;
        const isSidecar = Boolean(parsed.sidecar) || /-(?:review|sidecar)$/i.test(name);
        const entry: AntigravityProjectCatalogEntry = { id, name, isSidecar };
        byId.set(id, entry);
        for (const res of parsed.projectResources?.resources ?? []) {
          const uri =
            typeof res.gitFolder?.folderUri === "string"
              ? res.gitFolder.folderUri
              : typeof res.folderUri === "string"
                ? res.folderUri
                : "";
          if (!uri) continue;
          const folder = normalizeWorkspaceRoot(uri);
          const prev = byFolder.get(folder);
          if (!prev || (prev.isSidecar && !entry.isSidecar)) byFolder.set(folder, entry);
        }
      } catch {
        // ignore single malformed project file
      }
    }
  } catch {
    // ignore missing config directory
  }
  return { byId, byFolder };
}

export function resolveProjectDisplayName(
  catalog: AntigravityProjectCatalog,
  params: { projectId?: string; workspaceRoot?: string; projectKey: string },
): string {
  const pid = params.projectId?.trim() || "";
  if (pid && pid !== "outside-of-project" && pid !== "default-cli-project") {
    const byId = catalog.byId.get(pid);
    if (byId?.name) return byId.name;
  }
  if (params.workspaceRoot) {
    const byFolder = catalog.byFolder.get(params.workspaceRoot);
    if (byFolder?.name) return byFolder.name;
    if (!params.workspaceRoot.startsWith("isolated-worktree:")) {
      const base = path.basename(params.workspaceRoot);
      if (base) return base;
    }
  }
  if (pid) {
    const byId = catalog.byId.get(pid);
    if (byId?.name) return byId.name;
  }
  return params.projectKey.replace(/^repo:[^/]+\//, "").replace(/^local:[^:]+:/, "");
}

export interface AntigravitySessionSnapshot {
  uid: string;
  nodeId: string;
  surface: AntigravitySurface;
  conversationId: string;
  projectKey: string;
  projectId?: string;
  projectDisplayName: string;
  workspaceRoot?: string;
  workspaceUris: string[];
  title: string;
  preview: string;
  status: string;
  notFullyIdle: boolean;
  isRunning: boolean;
  sessionRole: AntigravitySessionRole;
  stepCount: number;
  lastUserInputStepIndex: number;
  lastModifiedMs?: number;
  effectiveLastModifiedMs?: number;
  lastModifiedIso: string;
  lastUserInputMs?: number;
  lastUserViewMs?: number;
  subagentCount: number;
  activeSubagentCount: number;
  childConversationIds: string[];
  activeChildConversationIds: string[];
  volumeOffline: boolean;
  withinCutover: boolean;
  superseded: boolean;
  supersededReasons: string[];
  hasError: boolean;
}

export interface AntigravitySurfacePaths {
  dbPath?: string;
  rootDir?: string;
  annotationsDir?: string;
}

export interface AntigravityStateReaderOptions {
  nodeId?: string;
  homeDir?: string;
  surfacePaths?: Partial<Record<AntigravitySurface, string | AntigravitySurfacePaths>>;
  bootstrappedAtMs?: number;
  cutoverHours?: number;
  nowMs?: () => number;
  existingPathChecker?: (fsPath: string) => boolean;
  remoteUrlResolver?: (workspaceRoot: string) => string | undefined;
  externalReadWatermarkMs?: Record<string, number>;
  probeTracker?: ZeroTokenProbeTracker;
}

export interface AntigravityScanOptions {
  nowMs?: number;
  bootstrappedAtMs?: number;
  cutoverHours?: number;
  externalReadWatermarkMs?: Record<string, number>;
  previousByUid?: ReadonlyMap<
    string,
    Pick<AntigravitySessionSnapshot, "stepCount" | "lastUserInputStepIndex" | "status" | "lastModifiedMs">
  >;
}

export interface AntigravityScanResult {
  scannedAtIso: string;
  cutoverIso: string;
  cutoverMs: number;
  surfacesScanned: AntigravitySurface[];
  sessions: AntigravitySessionSnapshot[];
  cadenceEvents: BridgeFleetCadenceEvent[];
  probeDecision: ZeroTokenProbeDecision;
}

interface RawSummaryRow {
  conversation_id: string;
  title: string;
  preview: string;
  step_count: number;
  last_modified_time: string;
  workspace_uris: string;
  status: string;
  project_id: string;
  agent_name: string;
  parent_conversation_id: string;
  nesting_depth: number;
  not_fully_idle: number | boolean;
  killed: number | boolean;
  last_user_input_time: string;
  last_user_input_step_index: number;
}

const SURFACE_DIR_MAP: Record<AntigravitySurface, string> = {
  app: "antigravity",
  cli: "antigravity-cli",
  ide: "antigravity-ide",
};

function parseWorkspaceUris(raw: string): string[] {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
    } catch {
      return [];
    }
  }
  return [trimmed];
}

function toFlagBool(val: unknown): boolean {
  if (typeof val === "boolean") return val;
  if (typeof val === "number") return val !== 0;
  if (typeof val === "string") return val === "1" || val.toLowerCase() === "true";
  return false;
}

function classifyRowSessionRole(row: RawSummaryRow): AntigravitySessionRole {
  if (Number(row.nesting_depth ?? 0) > 0 || String(row.parent_conversation_id ?? "").trim().length > 0) {
    return "subagent";
  }
  const agentAndTitle = `${row.agent_name ?? ""} ${row.title ?? ""}`;
  if (/(?:readonly[-_\s]?sidecar|sidecar|定时只读巡检|只读巡检|patrol|cron[-_\s]?monitor|health[-_\s]?check)/i.test(agentAndTitle)) {
    return "readonly-sidecar";
  }
  return "interactive";
}

function detectRowError(row: RawSummaryRow, role: AntigravitySessionRole): boolean {
  if (/(?:ERROR|FAILED|CRASHED|TIMEOUT)/i.test(String(row.status ?? ""))) return true;
  if (role === "readonly-sidecar") {
    const text = `${row.title ?? ""}\n${row.preview ?? ""}`;
    if (/(?:exit code [1-9]|unhandled|exception|fatal|failed:|error:|超时|报错|异常|失败)/i.test(text)) {
      return true;
    }
  }
  return false;
}

function readAnnotationViewMs(annotationsDir: string | undefined, conversationId: string): number | undefined {
  if (!annotationsDir) return undefined;
  try {
    const pbPath = path.join(annotationsDir, `${conversationId}.pbtxt`);
    if (!fs.existsSync(pbPath)) return undefined;
    return parseAntigravityTimestampMs(fs.readFileSync(pbPath, "utf8"));
  } catch {
    return undefined;
  }
}

function resolveSurfaceLocations(
  surface: AntigravitySurface,
  homeDir: string,
  custom?: string | AntigravitySurfacePaths,
): { dbPath: string; annotationsDir: string } {
  const defaultRoot = path.join(homeDir, ".gemini", SURFACE_DIR_MAP[surface]);
  if (typeof custom === "string") {
    const isDb = custom.endsWith(".db") || custom.endsWith(".sqlite");
    const rootDir = isDb ? path.dirname(custom) : custom;
    return {
      dbPath: isDb ? custom : path.join(custom, "conversation_summaries.db"),
      annotationsDir: path.join(rootDir, "annotations"),
    };
  }
  const rootDir = custom?.rootDir ?? (custom?.dbPath ? path.dirname(custom.dbPath) : defaultRoot);
  return {
    dbPath: custom?.dbPath ?? path.join(rootDir, "conversation_summaries.db"),
    annotationsDir: custom?.annotationsDir ?? path.join(rootDir, "annotations"),
  };
}

function readSurfaceRows(dbPath: string): RawSummaryRow[] {
  const db = new DatabaseSync(`${pathToFileURL(dbPath).href}?mode=ro`, { readOnly: true });
  try {
    const sql =
      "SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, " +
      "status, project_id, agent_name, parent_conversation_id, nesting_depth, not_fully_idle, " +
      "killed, last_user_input_time, last_user_input_step_index FROM conversation_summaries";
    return db.prepare(sql).all() as unknown as RawSummaryRow[];
  } finally {
    db.close();
  }
}

interface ChildRollup {
  childIds: string[];
  activeCount: number;
  activeChildIds: string[];
  latestChildModifiedMs: number;
}

function buildChildRollups(rows: RawSummaryRow[]): Map<string, ChildRollup> {
  const parentOf = new Map<string, string>();
  for (const row of rows) {
    const pid = String(row.parent_conversation_id ?? "").trim();
    if (pid) parentOf.set(row.conversation_id, pid);
  }
  const findRootId = (id: string): string | undefined => {
    let curr = parentOf.get(id);
    const seen = new Set<string>([id]);
    while (curr && !seen.has(curr)) {
      seen.add(curr);
      const next = parentOf.get(curr);
      if (!next) return curr;
      curr = next;
    }
    return undefined;
  };
  const rollups = new Map<string, ChildRollup>();
  for (const row of rows) {
    if (Number(row.nesting_depth ?? 0) <= 0) continue;
    const rootId = findRootId(row.conversation_id);
    if (!rootId) continue;
    const entry = rollups.get(rootId) ?? { childIds: [], activeCount: 0, activeChildIds: [], latestChildModifiedMs: 0 };
    entry.childIds.push(row.conversation_id);
    if (!toFlagBool(row.killed)) {
      const childMs = parseAntigravityTimestampMs(row.last_modified_time) ?? 0;
      if (childMs > entry.latestChildModifiedMs) entry.latestChildModifiedMs = childMs;
      if (row.status === "CASCADE_RUN_STATUS_RUNNING" || toFlagBool(row.not_fully_idle)) {
        entry.activeCount += 1;
        entry.activeChildIds.push(row.conversation_id);
      }
    }
    rollups.set(rootId, entry);
  }
  return rollups;
}

function computeSupersedeReasons(params: {
  status: string;
  notFullyIdle: boolean;
  stepCount: number;
  lastUserInputStepIndex: number;
  lastModifiedMs?: number;
  lastUserViewMs?: number;
  externalWatermarkMs?: number;
  prev?: Pick<AntigravitySessionSnapshot, "stepCount" | "lastUserInputStepIndex" | "status" | "lastModifiedMs">;
}): string[] {
  const reasons: string[] = [];
  if (params.prev && params.lastUserInputStepIndex > params.prev.lastUserInputStepIndex) {
    reasons.push("user_input_step_advanced");
  }
  if (params.prev && params.stepCount > params.prev.stepCount) {
    reasons.push("step_count_advanced");
  }
  if (params.status === "CASCADE_RUN_STATUS_RUNNING" || params.notFullyIdle) {
    reasons.push("session_running");
  }
  if (
    params.lastUserViewMs !== undefined &&
    params.lastModifiedMs !== undefined &&
    params.lastUserViewMs >= params.lastModifiedMs
  ) {
    reasons.push("user_viewed_in_ide");
  }
  if (
    params.externalWatermarkMs !== undefined &&
    params.lastModifiedMs !== undefined &&
    params.externalWatermarkMs >= params.lastModifiedMs
  ) {
    reasons.push("external_watermark");
  }
  return reasons;
}

function sessionToCadenceEvent(s: AntigravitySessionSnapshot): BridgeFleetCadenceEvent | undefined {
  if (!s.withinCutover || s.volumeOffline || s.superseded) return undefined;
  if (s.sessionRole === "readonly-sidecar") {
    if (!s.hasError) return undefined;
    return {
      id: `agy-err:${s.uid}`,
      dedupeKey: `agy-err:${s.uid}:${s.stepCount}`,
      kind: "node_or_sidecar_error",
      projectKey: s.projectKey,
      nodeId: s.nodeId,
      summary: s.title || s.preview || `Sidecar error in ${s.conversationId}`,
      actionHint: "Check sidecar logs and recover failing check.",
      urgency: "urgent",
      conversationId: s.conversationId,
      updatedAtIso: s.lastModifiedIso,
    };
  }
  if (s.sessionRole !== "interactive") return undefined;
  if (s.hasError) {
    return {
      id: `agy-err:${s.uid}`,
      dedupeKey: `agy-err:${s.uid}:${s.stepCount}`,
      kind: "node_or_sidecar_error",
      projectKey: s.projectKey,
      nodeId: s.nodeId,
      summary: s.title || s.preview || `Session error in ${s.conversationId}`,
      actionHint: "Inspect session error and resume or abort.",
      urgency: "urgent",
      conversationId: s.conversationId,
      updatedAtIso: s.lastModifiedIso,
    };
  }
  if (s.status === "CASCADE_RUN_STATUS_IDLE" || s.status === "") {
    return {
      id: `agy-rev:${s.uid}`,
      dedupeKey: `agy-rev:${s.uid}:${s.stepCount}`,
      kind: "review_ready",
      projectKey: s.projectKey,
      nodeId: s.nodeId,
      summary: s.title || s.preview || `Session ${s.conversationId} ready for review`,
      actionHint: "Review artifacts or reply to continue.",
      urgency: "normal",
      conversationId: s.conversationId,
      updatedAtIso: s.lastModifiedIso,
    };
  }
  return undefined;
}

export class AntigravityStateReader {
  private readonly nodeId: string;
  private readonly homeDir: string;
  private readonly surfacePaths: Partial<Record<AntigravitySurface, string | AntigravitySurfacePaths>>;
  private readonly defaultBootstrappedAtMs: number;
  private readonly cutoverHours: number;
  private readonly nowMsFn: () => number;
  private readonly existingPathChecker: (fsPath: string) => boolean;
  private readonly remoteUrlResolver?: (workspaceRoot: string) => string | undefined;
  private readonly defaultExternalWatermarks: Record<string, number>;
  private readonly probeTracker: ZeroTokenProbeTracker;
  private readonly previousSnapshots = new Map<string, AntigravitySessionSnapshot>();
  private readonly lastKnownOnlineByUid = new Map<string, AntigravitySessionSnapshot>();
  private hasEvaluatedProbe = false;

  constructor(options: AntigravityStateReaderOptions = {}) {
    this.nodeId = options.nodeId ?? "local-mac";
    this.homeDir = options.homeDir ?? os.homedir();
    this.surfacePaths = options.surfacePaths ?? {};
    this.nowMsFn = options.nowMs ?? (() => Date.now());
    this.defaultBootstrappedAtMs = options.bootstrappedAtMs ?? this.nowMsFn();
    this.cutoverHours = options.cutoverHours ?? 48;
    this.existingPathChecker = options.existingPathChecker ?? fs.existsSync;
    this.remoteUrlResolver = options.remoteUrlResolver;
    this.defaultExternalWatermarks = options.externalReadWatermarkMs ?? {};
    this.probeTracker = options.probeTracker ?? new ZeroTokenProbeTracker();
  }

  scan(options: AntigravityScanOptions = {}): AntigravityScanResult {
    const nowMs = options.nowMs ?? this.nowMsFn();
    const cutoverHours = options.cutoverHours ?? this.cutoverHours;
    const bootstrappedAtMs = options.bootstrappedAtMs ?? this.defaultBootstrappedAtMs;
    const cutoverMs = Math.max(bootstrappedAtMs, nowMs - cutoverHours * 3600_000);
    const watermarks = { ...this.defaultExternalWatermarks, ...(options.externalReadWatermarkMs ?? {}) };
    const surfacesScanned: AntigravitySurface[] = [];
    const sessions: AntigravitySessionSnapshot[] = [];
    const catalog = loadAntigravityProjectCatalog(this.homeDir);

    for (const surface of ["app", "cli", "ide"] as const) {
      const { dbPath, annotationsDir } = resolveSurfaceLocations(surface, this.homeDir, this.surfacePaths[surface]);
      if (!fs.existsSync(dbPath)) continue;
      surfacesScanned.push(surface);
      const rows = readSurfaceRows(dbPath);
      const rollups = buildChildRollups(rows);
      for (const row of rows) {
        if (Number(row.nesting_depth ?? 0) !== 0 || toFlagBool(row.killed)) continue;
        const snap = this.buildRootSnapshot(row, surface, annotationsDir, rollups, cutoverMs, watermarks, catalog, options.previousByUid);
        sessions.push(snap);
        this.previousSnapshots.set(snap.uid, snap);
        if (!snap.volumeOffline) this.lastKnownOnlineByUid.set(snap.uid, snap);
      }
    }

    const cadenceEvents = sessions.map(sessionToCadenceEvent).filter((e): e is BridgeFleetCadenceEvent => Boolean(e));
    cadenceEvents.sort((a, b) => a.id.localeCompare(b.id));
    const hasError = cadenceEvents.some((e) => e.kind === "node_or_sidecar_error");
    const digestPayload = JSON.stringify(
      cadenceEvents.map((e) => ({ id: e.id, kind: e.kind, projectKey: e.projectKey, summary: e.summary, updatedAtIso: e.updatedAtIso })),
    );
    const probeId = `antigravity-state:${this.nodeId}`;
    const scannedAtIso = new Date(nowMs).toISOString();
    if (!this.hasEvaluatedProbe && !hasError && cadenceEvents.length > 0) {
      this.probeTracker.evaluate({ probeId, healthy: true, output: "[]", wakeOnDiff: true, at: scannedAtIso });
    }
    this.hasEvaluatedProbe = true;
    const probeDecision = this.probeTracker.evaluate({
      probeId,
      healthy: !hasError,
      output: digestPayload,
      wakeOnDiff: true,
      at: scannedAtIso,
    });
    return { scannedAtIso, cutoverIso: new Date(cutoverMs).toISOString(), cutoverMs, surfacesScanned, sessions, cadenceEvents, probeDecision };
  }

  private buildRootSnapshot(
    row: RawSummaryRow,
    surface: AntigravitySurface,
    annotationsDir: string,
    rollups: Map<string, ChildRollup>,
    cutoverMs: number,
    watermarks: Record<string, number>,
    catalog: AntigravityProjectCatalog,
    overridePrev?: AntigravityScanOptions["previousByUid"],
  ): AntigravitySessionSnapshot {
    const conversationId = String(row.conversation_id);
    const uid = `${this.nodeId}:${surface}:${conversationId}`;
    const workspaceUris = parseWorkspaceUris(row.workspace_uris);
    const workspaceRoot = workspaceUris[0] ? normalizeWorkspaceRoot(workspaceUris[0]) : undefined;
    const isFsPath = Boolean(workspaceRoot) && (workspaceRoot!.startsWith("/") || /^[A-Za-z]:\//.test(workspaceRoot!));
    const volumeOffline = isFsPath ? !this.existingPathChecker(workspaceRoot!) : false;
    const frozen = volumeOffline ? this.lastKnownOnlineByUid.get(uid) : undefined;
    if (frozen) return { ...frozen, volumeOffline: true };

    const sessionRole = classifyRowSessionRole(row);
    const hasError = detectRowError(row, sessionRole);
    const lastModifiedMs = parseAntigravityTimestampMs(row.last_modified_time);
    const lastModifiedIso = lastModifiedMs !== undefined ? new Date(lastModifiedMs).toISOString() : new Date(0).toISOString();
    const lastUserInputMs = parseAntigravityTimestampMs(row.last_user_input_time);
    const lastUserViewMs = readAnnotationViewMs(annotationsDir, conversationId);
    const remoteUrl = workspaceRoot && !volumeOffline
      ? this.remoteUrlResolver?.(workspaceRoot) ?? readGitOriginUrl(workspaceRoot)
      : undefined;
    const projectId = typeof row.project_id === "string" && row.project_id.trim() ? row.project_id.trim() : undefined;
    const projectKey = canonicalizeProjectKey({
      remoteUrl,
      nodeId: this.nodeId,
      folderPath: workspaceRoot,
      explicitKey: !workspaceRoot && projectId ? projectId : undefined,
    });
    const projectDisplayName = resolveProjectDisplayName(catalog, { projectId, workspaceRoot, projectKey });
    const stepCount = Number(row.step_count ?? 0);
    const lastUserInputStepIndex = Number(row.last_user_input_step_index ?? -1);
    const status = String(row.status ?? "");
    const notFullyIdle = toFlagBool(row.not_fully_idle);
    const prev = overridePrev?.get(uid) ?? this.previousSnapshots.get(uid);
    const prevFull = this.previousSnapshots.get(uid);
    const extWm = watermarks[uid] ?? watermarks[conversationId];
    const supersededReasons = computeSupersedeReasons({
      status, notFullyIdle, stepCount, lastUserInputStepIndex, lastModifiedMs, lastUserViewMs, externalWatermarkMs: extWm, prev,
    });
    const unchangedPrevSuperseded = Boolean(
      !overridePrev && prevFull?.superseded && prevFull.stepCount === stepCount &&
      prevFull.lastModifiedMs === lastModifiedMs && prevFull.status === status,
    );
    const superseded = supersededReasons.length > 0 || unchangedPrevSuperseded;
    const rollup = rollups.get(conversationId);
    const activeSubagentCount = rollup?.activeCount ?? 0;
    const activeChildConversationIds = rollup?.activeChildIds ?? [];
    const isRunning = status === "CASCADE_RUN_STATUS_RUNNING" || notFullyIdle || activeSubagentCount > 0;
    const effectiveLastModifiedMs = Math.max(lastModifiedMs ?? 0, rollup?.latestChildModifiedMs ?? 0) || undefined;
    const withinCutover = (effectiveLastModifiedMs ?? lastModifiedMs) !== undefined ? (effectiveLastModifiedMs ?? lastModifiedMs)! > cutoverMs : false;
    return {
      uid, nodeId: this.nodeId, surface, conversationId, projectKey,
      ...(projectId ? { projectId } : {}), projectDisplayName,
      ...(workspaceRoot ? { workspaceRoot } : {}), workspaceUris,
      title: String(row.title ?? ""), preview: String(row.preview ?? ""), status, notFullyIdle, isRunning, sessionRole,
      stepCount, lastUserInputStepIndex, ...(lastModifiedMs !== undefined ? { lastModifiedMs } : {}),
      ...(effectiveLastModifiedMs !== undefined ? { effectiveLastModifiedMs } : {}),
      lastModifiedIso, ...(lastUserInputMs !== undefined ? { lastUserInputMs } : {}),
      ...(lastUserViewMs !== undefined ? { lastUserViewMs } : {}),
      subagentCount: rollup?.childIds.length ?? 0, activeSubagentCount,
      childConversationIds: rollup?.childIds ?? [], activeChildConversationIds,
      volumeOffline, withinCutover, superseded,
      supersededReasons: unchangedPrevSuperseded && supersededReasons.length === 0 ? prevFull!.supersededReasons : supersededReasons,
      hasError,
    };
  }
}

function toIsoOrFallback(raw: unknown, fallbackIso: string): string {
  if (typeof raw === "string" && raw.trim()) {
    const ms = parseAntigravityTimestampMs(raw);
    if (ms !== undefined) return new Date(ms).toISOString();
  }
  return fallbackIso;
}

function normalizeFleetEventItem(
  item: Record<string, unknown>,
  defaultKind: BridgeFleetCadenceKind,
  fallbackNodeId: string,
  fallbackIso: string,
): BridgeFleetCadenceEvent | undefined {
  const rawKind = String(item.kind ?? defaultKind) as BridgeFleetCadenceKind;
  const kind: BridgeFleetCadenceKind =
    rawKind === "red_collision" ||
    rawKind === "node_or_sidecar_error" ||
    rawKind === "pending_handoff" ||
    rawKind === "review_ready"
      ? rawKind
      : defaultKind;
  const projectKey = String(item.projectKey ?? item.project_key ?? "local:fleet:unknown").trim();
  const nodeId = String(item.nodeId ?? item.node_id ?? item.targetNodeId ?? fallbackNodeId).trim();
  const id = String(item.id ?? item.handoffId ?? item.collisionId ?? `${kind}:${projectKey}:${nodeId}`);
  const summary = String(item.summary ?? item.message ?? item.error ?? item.sidecarError ?? item.title ?? id).trim();
  const urgency: "normal" | "urgent" =
    item.urgency === "urgent" || item.urgency === "normal"
      ? item.urgency
      : kind === "red_collision" || kind === "node_or_sidecar_error"
        ? "urgent"
        : "normal";
  const conversationId =
    typeof item.conversationId === "string" && item.conversationId.trim()
      ? item.conversationId.trim()
      : typeof item.conversation_id === "string" && item.conversation_id.trim()
        ? item.conversation_id.trim()
        : undefined;
  const updatedAtIso = toIsoOrFallback(item.updatedAtIso ?? item.updatedAt ?? item.updated_at, fallbackIso);
  return {
    id,
    dedupeKey: String(item.dedupeKey ?? item.dedupe_key ?? `${kind}:${id}:${updatedAtIso}`),
    kind,
    projectKey,
    nodeId,
    summary,
    actionHint: String(item.actionHint ?? item.action_hint ?? (kind === "red_collision" ? "Resolve multi-node collision." : "Review fleet pulse.")),
    urgency,
    ...(conversationId ? { conversationId } : {}),
    ...(typeof item.superseded === "boolean" ? { superseded: item.superseded } : {}),
    updatedAtIso,
  };
}

export interface FleetPulseReaderOptions {
  stateFilePath?: string;
  fallbackNodeId?: string;
  nowIso?: () => string;
}

export class FleetPulseReader {
  private readonly stateFilePath: string;
  private readonly fallbackNodeId: string;
  private readonly nowIsoFn: () => string;

  constructor(options: string | FleetPulseReaderOptions = {}) {
    if (typeof options === "string") {
      this.stateFilePath = options;
      this.fallbackNodeId = "remote-node";
      this.nowIsoFn = () => new Date().toISOString();
    } else {
      this.stateFilePath = options.stateFilePath ?? path.join(os.homedir(), ".ops_fleet_state.json");
      this.fallbackNodeId = options.fallbackNodeId ?? "remote-node";
      this.nowIsoFn = options.nowIso ?? (() => new Date().toISOString());
    }
  }

  read(overridePath?: string): BridgeFleetCadenceEvent[] {
    const targetPath = overridePath ?? this.stateFilePath;
    let parsed: unknown;
    try {
      if (!fs.existsSync(targetPath)) return [];
      parsed = JSON.parse(fs.readFileSync(targetPath, "utf8"));
    } catch {
      return [];
    }
    if (!parsed || typeof parsed !== "object") return [];
    const fallbackIso = toIsoOrFallback((parsed as Record<string, unknown>).generatedAt ?? (parsed as Record<string, unknown>).updatedAt, this.nowIsoFn());
    const out: BridgeFleetCadenceEvent[] = [];
    const pushItem = (raw: unknown, defaultKind: BridgeFleetCadenceKind) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      const ev = normalizeFleetEventItem(raw as Record<string, unknown>, defaultKind, this.fallbackNodeId, fallbackIso);
      if (ev) out.push(ev);
    };

    if (Array.isArray(parsed)) {
      for (const item of parsed) pushItem(item, "pending_handoff");
      return out;
    }
    const rec = parsed as Record<string, unknown>;
    const collisions = (rec.collisions ?? rec.redCollisions ?? rec.red_collisions) as unknown;
    if (Array.isArray(collisions)) for (const c of collisions) pushItem(c, "red_collision");

    const handoffs = (rec.handoffs ?? rec.pendingHandoffs ?? rec.pending_handoffs) as unknown;
    if (Array.isArray(handoffs)) {
      for (const h of handoffs) {
        const st = typeof (h as Record<string, unknown>)?.status === "string" ? String((h as Record<string, unknown>).status).toLowerCase() : "pending";
        if (st === "pending" || st === "open") pushItem(h, "pending_handoff");
      }
    }
    const rawNodes = rec.nodes ?? rec.workers ?? rec.sidecars;
    const nodeEntries: unknown[] = Array.isArray(rawNodes) ? rawNodes : rawNodes && typeof rawNodes === "object" ? Object.entries(rawNodes as Record<string, unknown>).map(([k, v]) => (v && typeof v === "object" ? { nodeId: k, ...(v as Record<string, unknown>) } : { nodeId: k })) : [];
    for (const n of nodeEntries) {
      if (!n || typeof n !== "object") continue;
      const nr = n as Record<string, unknown>;
      const status = String(nr.status ?? "").toLowerCase();
      const err = nr.error ?? nr.sidecarError ?? nr.sidecar_error;
      if (status === "error" || status === "offline" || status === "unhealthy" || status === "failed" || (typeof err === "string" && err.trim())) {
        pushItem({ projectKey: nr.projectKey ?? "local:fleet:node", ...nr, summary: err ?? nr.summary ?? `Node/sidecar ${nr.nodeId ?? "unknown"} error` }, "node_or_sidecar_error");
      }
    }
    const extraEvents = rec.events ?? rec.pulses;
    if (Array.isArray(extraEvents)) for (const e of extraEvents) pushItem(e, "review_ready");
    return out;
  }
}

const SENSITIVE_PROJECT_RE =
  /(?:wallet|vault|secret|credential|career|accounting|private[-_]?key|简历|财务|账本|密钥|合同|薪资|私密|客户台账)/i;

const GOVERNANCE_ANCHORS = ["ROADMAP.md", "TASKS.md", "TOMBSTONES.md", ".agents", "PROJECT.md"] as const;

const HIGH_TIER_BODY_FIELDS = new Set([
  "summary",
  "body",
  "text",
  "content",
  "markdownBody",
  "title",
  "preview",
  "transcript",
  "artifactContent",
  "diff",
  "walkthrough",
  "plan",
  "details",
  "workspacePath",
  "absolutePath",
  "rawPath",
  "localPath",
  "filePaths",
  "notes",
  "description",
  "actionHint",
  "lastUserInput",
]);

function writeJsonAtomic600(targetPath: string, data: unknown): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const tmpPath = path.join(dir, `.tmp-${path.basename(targetPath)}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Ignore cleanup error
    }
    throw err;
  }
}

export interface ProjectPrivacyRegistryOptions {
  dataDir: string;
  registeredProjectKeys?: Iterable<string>;
  nowIso?: () => string;
}

export interface ProjectHeuristicInput {
  projectKey: string;
  workspaceRoot?: string;
  title?: string;
  isRegistered?: boolean;
  isExternalVolume?: boolean;
}

function hasGovernanceAnchor(workspaceRoot?: string): boolean {
  if (!workspaceRoot || workspaceRoot.startsWith("isolated-worktree:")) return false;
  try {
    if (!fs.existsSync(workspaceRoot)) return false;
    return GOVERNANCE_ANCHORS.some((anchor) => fs.existsSync(path.join(workspaceRoot, anchor)));
  } catch {
    return false;
  }
}

export class ProjectPrivacyRegistry {
  private readonly filePath: string;
  private readonly nowIsoFn: () => string;
  private readonly registeredKeys = new Set<string>();
  private readonly policies = new Map<string, ProjectPrivacyPolicy>();

  constructor(options: string | ProjectPrivacyRegistryOptions) {
    const dataDir = typeof options === "string" ? options : options.dataDir;
    this.filePath = path.join(dataDir, "sugent-stewardship", "project-privacy.json");
    this.nowIsoFn = typeof options === "string" ? () => new Date().toISOString() : options.nowIso ?? (() => new Date().toISOString());
    if (typeof options !== "string" && options.registeredProjectKeys) {
      for (const key of options.registeredProjectKeys) {
        if (key.trim()) this.registeredKeys.add(key.trim());
      }
    }
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as {
        projects?: Record<string, ProjectPrivacyPolicy>;
        registeredKeys?: string[];
      };
      if (Array.isArray(raw.registeredKeys)) {
        for (const k of raw.registeredKeys) if (typeof k === "string" && k.trim()) this.registeredKeys.add(k.trim());
      }
      if (raw.projects && typeof raw.projects === "object") {
        for (const [k, v] of Object.entries(raw.projects)) {
          if (v && (v.tier === 0 || v.tier === 1 || v.tier === 2)) this.policies.set(k, v);
        }
      }
    } catch {
      // Corrupt privacy file starts clean in memory until saved
    }
  }

  private save(): void {
    writeJsonAtomic600(this.filePath, {
      version: 1,
      updatedAt: this.nowIsoFn(),
      registeredKeys: Array.from(this.registeredKeys).sort(),
      projects: Object.fromEntries(Array.from(this.policies.entries()).sort(([a], [b]) => a.localeCompare(b))),
    });
  }

  registerProject(projectKey: string): void {
    const clean = projectKey.trim();
    if (!clean) return;
    this.registeredKeys.add(clean);
    this.save();
  }

  getProjectPolicy(projectKey: string): ProjectPrivacyPolicy | undefined {
    const p = this.policies.get(projectKey);
    return p ? { ...p } : undefined;
  }

  listPolicies(): ProjectPrivacyPolicy[] {
    return Array.from(this.policies.values()).map((p) => ({ ...p }));
  }

  classifyHeuristic(input: ProjectHeuristicInput): { tier: PrivacyTier; reason: string; registered: boolean } {
    const isRegistered = Boolean(input.isRegistered || this.registeredKeys.has(input.projectKey) || this.policies.get(input.projectKey)?.registered);
    const corpus = `${input.projectKey} ${input.workspaceRoot ?? ""} ${input.title ?? ""}`;
    if (SENSITIVE_PROJECT_RE.test(corpus)) {
      return { tier: 0, reason: "sensitive_keyword_detected", registered: isRegistered };
    }
    const isExtVol = Boolean(input.isExternalVolume) || /^\/(?:Volumes|mnt|media)\//i.test(input.workspaceRoot ?? "");
    if (isExtVol && !isRegistered) {
      return { tier: 0, reason: "unregistered_external_volume", registered: false };
    }
    if (isRegistered && hasGovernanceAnchor(input.workspaceRoot)) {
      return { tier: 2, reason: "registered_with_governance_anchor", registered: true };
    }
    return { tier: 1, reason: "default_summary_radar", registered: isRegistered };
  }

  resolveProjectPolicy(input: ProjectHeuristicInput): ProjectPrivacyPolicy {
    const existing = this.policies.get(input.projectKey);
    if (existing && existing.tierSource === "user_override") return { ...existing };
    const heuristic = this.classifyHeuristic(input);
    const nextEpoch = existing ? (existing.tier !== heuristic.tier ? existing.tierEpoch + 1 : existing.tierEpoch) : 1;
    const policy: ProjectPrivacyPolicy = {
      projectKey: input.projectKey,
      tier: heuristic.tier,
      tierSource: "heuristic",
      tierEpoch: nextEpoch,
      registered: heuristic.registered,
      reason: heuristic.reason,
      updatedAt: this.nowIsoFn(),
    };
    this.policies.set(input.projectKey, policy);
    this.save();
    return { ...policy };
  }

  setProjectTier(projectKey: string, tier: PrivacyTier, reason = "user_override"): ProjectPrivacyPolicy {
    if (tier !== 0 && tier !== 1 && tier !== 2) throw new Error(`Invalid PrivacyTier: ${String(tier)}`);
    const existing = this.policies.get(projectKey);
    const policy: ProjectPrivacyPolicy = {
      projectKey,
      tier,
      tierSource: "user_override",
      tierEpoch: (existing?.tierEpoch ?? 0) + 1,
      registered: existing?.registered ?? this.registeredKeys.has(projectKey),
      reason,
      updatedAt: this.nowIsoFn(),
    };
    this.policies.set(projectKey, policy);
    this.save();
    return { ...policy };
  }

  sanitizeForProjectTier<T extends Record<string, unknown>>(
    payload: T,
    projectKey: string,
    incomingTierEpoch?: number,
  ): SanitizedTierPayloadResult {
    const policy = this.getProjectPolicy(projectKey) ?? this.resolveProjectPolicy({ projectKey });
    const allKeys = Object.keys(payload);
    if (incomingTierEpoch !== undefined && incomingTierEpoch < policy.tierEpoch) {
      return {
        allowed: false, rejected: true, staleEpoch: true,
        tier: policy.tier, tierEpoch: policy.tierEpoch, strippedFields: allKeys,
        sanitized: {}, reason: "stale_tier_epoch",
      };
    }
    if (policy.tier === 0) {
      return {
        allowed: false, rejected: true, staleEpoch: false,
        tier: 0, tierEpoch: policy.tierEpoch, strippedFields: allKeys,
        sanitized: {}, reason: "tier_0_local_only",
      };
    }
    const strippedFields: string[] = [];
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) {
      if ((policy.tier === 1 && HIGH_TIER_BODY_FIELDS.has(k)) || (typeof v === "string" && looksSecret(v))) {
        strippedFields.push(k);
        continue;
      }
      sanitized[k] = v;
    }
    sanitized.tierEpoch = policy.tierEpoch;
    return { allowed: true, rejected: false, staleEpoch: false, tier: policy.tier, tierEpoch: policy.tierEpoch, strippedFields, sanitized };
  }
}

export interface StagedPluginHooksResult {
  pluginDir: string;
  pluginJsonPath: string;
  hooksJsonPath: string;
}

function expandHomePath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

export function stageSugentStewardPluginHooks(
  pluginsRootDir: string,
  hookCommand: string,
  options: { pluginName?: string; includePostToolUse?: boolean } = {},
): StagedPluginHooksResult {
  const expanded = expandHomePath(pluginsRootDir);
  if (!expanded) throw new Error("pluginsRootDir cannot be empty.");
  const resolvedRoot = path.resolve(expanded);
  const globalConfigDir = path.resolve(os.homedir(), ".gemini", "config");
  const globalHooksPath = path.join(globalConfigDir, "hooks.json");

  if (
    resolvedRoot === globalHooksPath ||
    resolvedRoot === globalConfigDir ||
    path.basename(resolvedRoot) === "hooks.json" ||
    expanded.replace(/\\/g, "/").endsWith("/.gemini/config/hooks.json")
  ) {
    throw new Error("Refusing to write to global ~/.gemini/config/hooks.json; use an isolated plugin directory.");
  }

  const pluginName = options.pluginName?.trim() || "sugent-steward";
  const pluginDir = path.join(resolvedRoot, pluginName);
  const pluginJsonPath = path.join(pluginDir, "plugin.json");
  const hooksJsonPath = path.join(pluginDir, "hooks.json");

  for (const checkPath of [resolvedRoot, pluginDir, hooksJsonPath, pluginJsonPath]) {
    if (fs.existsSync(checkPath) && fs.lstatSync(checkPath).isSymbolicLink()) {
      throw new Error(`Refusing to overwrite symbolic link at ${checkPath}`);
    }
  }

  fs.mkdirSync(pluginDir, { recursive: true, mode: 0o755 });
  const stopCmd = `SUGENT_HOOK_PAYLOAD="$(cat)" nohup ${hookCommand} >/dev/null 2>&1 </dev/null & printf '{"decision":"allow"}\\n'`;
  const postToolCmd = `SUGENT_HOOK_PAYLOAD="$(cat)" nohup ${hookCommand} >/dev/null 2>&1 </dev/null & printf '{}\\n'`;

  const pluginManifest = {
    name: pluginName,
    description: "Sugent personal steward lifecycle hooks and isolated bridge",
  };
  const hooksConfig: Record<string, unknown> = {
    "sugent-steward-lifecycle": {
      Stop: [{ type: "command", command: stopCmd, timeout: 5 }],
      ...(options.includePostToolUse !== false
        ? { PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: postToolCmd, timeout: 5 }] }] }
        : {}),
    },
  };

  fs.writeFileSync(pluginJsonPath, `${JSON.stringify(pluginManifest, null, 2)}\n`, "utf8");
  fs.writeFileSync(hooksJsonPath, `${JSON.stringify(hooksConfig, null, 2)}\n`, "utf8");
  return { pluginDir, pluginJsonPath, hooksJsonPath };
}

export interface AntigravityHookSinkOptions {
  registry?: PersonalSourceRegistry;
  nodeId?: string;
  surface?: AntigravitySurface;
  defaultOwnerId?: string;
  allowedSenderIds?: Iterable<string>;
  instanceId?: string;
  onTrigger?: (trigger: PersonalTrigger) => void;
}

export interface HookHandleOptions {
  hookEventName?: string;
  nodeId?: string;
  surface?: AntigravitySurface;
  ownerId?: string;
  allowedSenderIds?: Iterable<string>;
  workspaceDir?: string;
  onTrigger?: (trigger: PersonalTrigger) => void;
}

export interface HookProcessResult {
  stdoutJson: string;
  shortCircuited: boolean;
  trigger?: PersonalTrigger;
  elapsedMs: number;
}

function inferSurfaceFromHook(parsed: Record<string, unknown>, fallback: AntigravitySurface): AntigravitySurface {
  const hint = `${String(parsed.transcriptPath ?? "")} ${String(parsed.artifactDirectoryPath ?? "")}`;
  if (hint.includes("antigravity-cli")) return "cli";
  if (hint.includes("antigravity-ide")) return "ide";
  if (hint.includes("antigravity")) return "app";
  return fallback;
}

export class AntigravityHookSink {
  private readonly registry: PersonalSourceRegistry;
  private readonly nodeId: string;
  private readonly surface: AntigravitySurface;
  private readonly defaultOwnerId: string;
  private readonly allowedSenderIds: string[];
  private readonly instanceId: string;
  private readonly onTrigger?: (trigger: PersonalTrigger) => void;

  constructor(options: AntigravityHookSinkOptions = {}) {
    this.registry = options.registry ?? new PersonalSourceRegistry();
    this.nodeId = options.nodeId ?? "local-mac";
    this.surface = options.surface ?? "app";
    this.defaultOwnerId = options.defaultOwnerId ?? "owner";
    this.allowedSenderIds = options.allowedSenderIds ? Array.from(options.allowedSenderIds) : [this.defaultOwnerId];
    this.instanceId = options.instanceId ?? "agy-hook-sink";
    this.onTrigger = options.onTrigger;
  }

  processHookStdin(rawJson: string, options: HookHandleOptions = {}): HookProcessResult {
    const t0 = performance.now();
    let parsed: Record<string, unknown>;
    try {
      const val = JSON.parse(rawJson);
      parsed = val && typeof val === "object" && !Array.isArray(val) ? (val as Record<string, unknown>) : {};
    } catch {
      const stdoutJson = options.hookEventName === "Stop" ? '{"decision":"allow"}' : "{}";
      return { stdoutJson, shortCircuited: true, elapsedMs: performance.now() - t0 };
    }

    const hookEvent = String(parsed.hookEventName ?? options.hookEventName ?? "PostToolUse");
    const stdoutJson = hookEvent === "Stop" ? '{"decision":"allow"}' : "{}";
    const cwd = typeof parsed.cwd === "string" ? parsed.cwd : Array.isArray(parsed.workspacePaths) && typeof parsed.workspacePaths[0] === "string" ? parsed.workspacePaths[0] : undefined;
    const transcriptPath = typeof parsed.transcriptPath === "string" ? parsed.transcriptPath : undefined;
    const nestingDepth = typeof parsed.nestingDepth === "number" ? parsed.nestingDepth : undefined;

    if (isSubagentSession({ cwd, transcriptPath, nestingDepth })) {
      return { stdoutJson, shortCircuited: true, elapsedMs: performance.now() - t0 };
    }
    return this.ingestRootHook(parsed, hookEvent, stdoutJson, cwd, options, t0);
  }

  private ingestRootHook(
    parsed: Record<string, unknown>,
    hookEvent: string,
    stdoutJson: string,
    cwd: string | undefined,
    options: HookHandleOptions,
    t0: number,
  ): HookProcessResult {
    const nodeId = options.nodeId ?? this.nodeId;
    const surface = options.surface ?? inferSurfaceFromHook(parsed, this.surface);
    const conversationId = typeof parsed.conversationId === "string" && parsed.conversationId.trim() ? parsed.conversationId.trim() : "unknown";
    const workspacePath = cwd ? normalizeWorkspaceRoot(cwd) : undefined;
    const remoteUrl = workspacePath ? readGitOriginUrl(workspacePath) : undefined;
    const projectKey = workspacePath ? canonicalizeProjectKey({ remoteUrl, folderPath: workspacePath, nodeId }) : undefined;
    const eventId =
      typeof parsed.eventId === "string" && parsed.eventId.trim()
        ? parsed.eventId.trim()
        : `${hookEvent}-${conversationId}-${crypto.createHash("sha256").update(JSON.stringify(parsed)).digest("hex").slice(0, 8)}`;
    const ownerId = options.ownerId ?? (typeof parsed.ownerId === "string" && parsed.ownerId.trim() ? parsed.ownerId.trim() : this.defaultOwnerId);
    const summary =
      typeof parsed.summary === "string" && parsed.summary.trim()
        ? parsed.summary.trim()
        : typeof parsed.lastUserInput === "string" && parsed.lastUserInput.trim()
          ? `[${hookEvent}] ${parsed.lastUserInput.trim().slice(0, 120)}`
          : `[${hookEvent}] ${conversationId}`;

    const ingestPayload = {
      eventId,
      nodeId,
      surface,
      conversationId,
      ...(projectKey ? { projectKey } : {}),
      ...(workspacePath ? { workspacePath } : {}),
      hookEvent,
      ...(typeof parsed.terminationReason === "string" ? { terminationReason: parsed.terminationReason } : {}),
      ...(typeof parsed.fullyIdle === "boolean" ? { fullyIdle: parsed.fullyIdle } : {}),
      summary,
      ownerId,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
    };
    const allowed = options.allowedSenderIds ?? this.allowedSenderIds;
    const trigger = this.registry.ingest("antigravity", this.instanceId, ingestPayload, allowed, {
      ...(options.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
      eventType: `antigravity.${hookEvent.toLowerCase()}`,
    });
    options.onTrigger?.(trigger);
    this.onTrigger?.(trigger);
    return { stdoutJson, shortCircuited: false, trigger, elapsedMs: performance.now() - t0 };
  }

  handleRawHookStdin(rawJson: string, options: HookHandleOptions = {}): string {
    return this.processHookStdin(rawJson, options).stdoutJson;
  }
}

export * from "./antigravity-artifacts.js";
export * from "./antigravity-dispatcher.js";
