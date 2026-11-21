import fs from "node:fs";
import path from "node:path";
import { looksSecret } from "../agent/memory.js";
import type { ProjectPrivacyRegistry } from "./antigravity-bridge.js";
import type { CallerAccessDomain, StewardshipLedger } from "./stewardship-ledger.js";

export interface AuthorizedProjectRoot {
  projectKey: string;
  displayName: string;
  rootPath: string;
  sourceKind: "project_workspace" | "bound_repo" | "antigravity_brain";
}

export interface AuthorizedFileMatch {
  fileName: string;
  relativePath: string;
  absolutePath: string;
  projectKey: string;
  projectName: string;
  sourceKind: AuthorizedProjectRoot["sourceKind"] | "ledger_archive";
  sizeBytes: number;
  modifiedAtIso: string;
  mtimeMs: number;
}

export type ReadAuthorizedFileResult =
  | {
      ok: true;
      fileName: string;
      projectName: string;
      absolutePath: string;
      relativePath: string;
      totalChars: number;
      offsetChars: number;
      returnedChars: number;
      hasMore: boolean;
      nextOffsetChars?: number;
      content: string;
    }
  | {
      ok: false;
      errorCode: string;
      message: string;
      matches?: AuthorizedFileMatch[];
    };

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "release",
  "build",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".ruff_cache",
  ".mypy_cache",
  ".tox",
  "coverage",
  ".turbo",
  ".superpowers",
  "target",
  ".worktrees",
  ".cache",
]);

const SENSITIVE_NAME_RE =
  /(?:^\.env(?:\.|$)|\.pem$|\.key$|id_rsa|id_ed25519|credentials.*\.json|secret|anymodel\.db|conversation_summaries\.db|\.npmrc$|\.netrc$)/i;
const MAX_READABLE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_WALK_DEPTH = 6;
const MAX_ENTRIES_PER_ROOT = 15_000;

export function isSensitiveFilePath(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, "/");
  if (norm.includes("/.git/config") || norm.includes("/.ssh/")) return true;
  return SENSITIVE_NAME_RE.test(path.basename(norm));
}
function safeRealPathWithin(candidatePath: string, rootPath: string): string | undefined {
  try {
    const lstat = fs.lstatSync(candidatePath);
    if (lstat.isSymbolicLink() || !lstat.isFile()) return undefined;
    const realFile = fs.realpathSync(candidatePath);
    const realRoot = fs.realpathSync(path.resolve(rootPath));
    if (realFile === realRoot || realFile.startsWith(`${realRoot}${path.sep}`)) return realFile;
    return undefined;
  } catch {
    return undefined;
  }
}

function tokenizeQuery(query: string): string[] {
  const lower = query.toLowerCase();
  const ascii = lower.match(/[a-z0-9_.-]{2,}/g) ?? [];
  const han = Array.from(lower).filter((c) => /\p{Script=Han}/u.test(c));
  const bi: string[] = [];
  for (let i = 0; i + 1 < han.length; i++) bi.push(han[i]! + han[i + 1]!);
  return Array.from(new Set([...ascii, ...bi]));
}

function scoreFileMatch(fileName: string, relPath: string, mtimeMs: number, query: string): number {
  const q = query.trim().toLowerCase();
  const fnLower = fileName.toLowerCase();
  const relLower = relPath.toLowerCase();
  let score = 0;
  if (q) {
    if (fnLower === q) score += 150;
    else if (fnLower.includes(q)) score += 70;
    if (relLower.includes(q)) score += 35;
    const toks = tokenizeQuery(q);
    for (const tok of toks) {
      if (fnLower.includes(tok)) score += 18;
      else if (relLower.includes(tok)) score += 10;
    }
    if (score === 0) return 0;
  } else {
    score = 1;
  }
  const ext = path.extname(fnLower);
  if (ext === ".md" || ext === ".txt" || ext === ".json" || ext === ".log") score += 12;
  score += Math.min(10, Math.floor(mtimeMs / 86_400_000) % 10);
  return score;
}

function collectBrainRoots(homeDir: string, conversationId?: string): AuthorizedProjectRoot[] {
  const roots: AuthorizedProjectRoot[] = [];
  const surfaces = ["antigravity", "antigravity-cli", "antigravity-ide"];
  if (conversationId?.trim()) {
    const cleanId = path.basename(conversationId.trim());
    for (const surf of surfaces) {
      const dir = path.join(homeDir, ".gemini", surf, "brain", cleanId);
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        roots.push({ projectKey: `brain:${cleanId}`, displayName: `会话制品(${cleanId.slice(0, 8)})`, rootPath: dir, sourceKind: "antigravity_brain" });
      }
    }
    return roots;
  }
  const recent: Array<{ dir: string; id: string; mtimeMs: number }> = [];
  for (const surf of surfaces) {
    const brainBase = path.join(homeDir, ".gemini", surf, "brain");
    if (!fs.existsSync(brainBase)) continue;
    try {
      for (const entry of fs.readdirSync(brainBase, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const full = path.join(brainBase, entry.name);
        recent.push({ dir: full, id: entry.name, mtimeMs: fs.statSync(full).mtimeMs });
      }
    } catch { /* ignore */ }
  }
  recent.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const item of recent.slice(0, 15)) {
    roots.push({ projectKey: `brain:${item.id}`, displayName: `会话制品(${item.id.slice(0, 8)})`, rootPath: item.dir, sourceKind: "antigravity_brain" });
  }
  return roots;
}
export interface AuthorizedFileReaderOptions {
  homeDir: string;
  getProjectRoots: () => AuthorizedProjectRoot[];
  privacyRegistry: ProjectPrivacyRegistry;
  ledger?: StewardshipLedger;
}

export class AuthorizedFileReader {
  constructor(private readonly opts: AuthorizedFileReaderOptions) {}

  private isAllowedForCaller(root: AuthorizedProjectRoot, callerDomain: CallerAccessDomain): boolean {
    if (callerDomain === "owner_private") return true;
    if (root.sourceKind === "antigravity_brain") return false;
    const pol = this.opts.privacyRegistry.resolveProjectPolicy({ projectKey: root.projectKey, workspaceRoot: root.rootPath });
    return pol.tier > 0;
  }

  private resolveCandidateRoots(input: { projectQuery?: string; conversationId?: string; callerDomain: CallerAccessDomain }): AuthorizedProjectRoot[] {
    const baseRoots = this.opts.getProjectRoots().filter((r) => fs.existsSync(r.rootPath) && this.isAllowedForCaller(r, input.callerDomain));
    const pq = input.projectQuery?.trim().toLowerCase();
    const filteredProjects = pq
      ? baseRoots.filter((r) => [r.displayName, r.projectKey, path.basename(r.rootPath)].some((s) => s.toLowerCase().includes(pq)))
      : baseRoots;
    const brainRoots = input.callerDomain === "owner_private"
      ? collectBrainRoots(this.opts.homeDir, input.conversationId)
      : [];
    const out = input.conversationId?.trim() ? [...brainRoots, ...filteredProjects] : [...filteredProjects, ...brainRoots];
    const dedup = new Map<string, AuthorizedProjectRoot>();
    for (const r of out) {
      const key = path.resolve(r.rootPath);
      if (!dedup.has(key)) dedup.set(key, r);
    }
    return Array.from(dedup.values());
  }

  private walkRoot(root: AuthorizedProjectRoot, query: string): Array<{ match: AuthorizedFileMatch; score: number }> {
    const results: Array<{ match: AuthorizedFileMatch; score: number }> = [];
    const queue: Array<{ dir: string; depth: number }> = [{ dir: path.resolve(root.rootPath), depth: 0 }];
    let head = 0;
    let visited = 0;
    while (head < queue.length && visited < MAX_ENTRIES_PER_ROOT) {
      const cur = queue[head++]!;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(cur.dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (visited >= MAX_ENTRIES_PER_ROOT) break;
        visited += 1;
        const full = path.join(cur.dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".git") && cur.depth < MAX_WALK_DEPTH) {
            queue.push({ dir: full, depth: cur.depth + 1 });
          }
          continue;
        }
        if (!entry.isFile() || isSensitiveFilePath(full)) continue;
        const rel = path.relative(root.rootPath, full).replace(/\\/g, "/");
        let st: fs.Stats;
        try { st = fs.statSync(full); } catch { continue; }
        const score = scoreFileMatch(entry.name, rel, st.mtimeMs, query);
        if (score <= 0) continue;
        results.push({
          score,
          match: {
            fileName: entry.name,
            relativePath: rel,
            absolutePath: full,
            projectKey: root.projectKey,
            projectName: root.displayName,
            sourceKind: root.sourceKind,
            sizeBytes: st.size,
            modifiedAtIso: new Date(st.mtimeMs).toISOString(),
            mtimeMs: st.mtimeMs,
          },
        });
      }
    }
    return results;
  }
  searchFiles(input: {
    query?: string;
    projectQuery?: string;
    conversationId?: string;
    callerDomain?: CallerAccessDomain;
    limit?: number;
  } = {}): AuthorizedFileMatch[] {
    const domain: CallerAccessDomain = input.callerDomain ?? "owner_private";
    const query = String(input.query ?? "").trim();
    const limit = Math.max(1, Math.min(30, Math.trunc(input.limit ?? 10)));
    const roots = this.resolveCandidateRoots({ projectQuery: input.projectQuery, conversationId: input.conversationId, callerDomain: domain });
    const scored: Array<{ match: AuthorizedFileMatch; score: number }> = [];

    for (const root of roots) {
      scored.push(...this.walkRoot(root, query));
    }
    if (query && this.opts.ledger) {
      for (const item of this.opts.ledger.findArchiveResources(query, domain)) {
        if (!item.localUriOrPath || isSensitiveFilePath(item.localUriOrPath)) continue;
        const p = path.resolve(item.localUriOrPath);
        if (!fs.existsSync(p)) continue;
        try {
          const st = fs.statSync(p);
          if (!st.isFile()) continue;
          const fn = path.basename(p);
          scored.push({
            score: Math.max(40, scoreFileMatch(fn, fn, st.mtimeMs, query)),
            match: {
              fileName: fn,
              relativePath: fn,
              absolutePath: p,
              projectKey: "ledger:archive",
              projectName: item.title || "个人档案库",
              sourceKind: "ledger_archive",
              sizeBytes: st.size,
              modifiedAtIso: new Date(st.mtimeMs).toISOString(),
              mtimeMs: st.mtimeMs,
            },
          });
        } catch { /* ignore */ }
      }
    }

    scored.sort((a, b) => b.score - a.score || b.match.mtimeMs - a.match.mtimeMs);
    const seen = new Set<string>();
    const out: AuthorizedFileMatch[] = [];
    for (const item of scored) {
      const key = path.resolve(item.match.absolutePath);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item.match);
      if (out.length >= limit) break;
    }
    return out;
  }

  private readTextSlice(match: AuthorizedFileMatch, offsetChars: number, maxChars: number, callerDomain: CallerAccessDomain): ReadAuthorizedFileResult {
    let st: fs.Stats;
    try { st = fs.statSync(match.absolutePath); } catch { return { ok: false, errorCode: "FILE_UNREADABLE", message: "文件不存在或无法读取。" }; }
    if (st.size > MAX_READABLE_FILE_BYTES) {
      return { ok: false, errorCode: "FILE_TOO_LARGE", message: `文件超过单次可读上限（${MAX_READABLE_FILE_BYTES} 字节）。` };
    }
    const rawBuf = fs.readFileSync(match.absolutePath);
    if (rawBuf.subarray(0, 1024).includes(0)) {
      return { ok: false, errorCode: "BINARY_FILE_UNSUPPORTED", message: "该文件为二进制文件，暂不支持纯文本全文阅读。" };
    }
    let fullText = rawBuf.toString("utf8");
    if (callerDomain !== "owner_private") {
      fullText = fullText.split(/\r?\n/).map((l) => (looksSecret(l) ? "[已脱敏敏感片段]" : l)).join("\n");
    }
    const totalChars = fullText.length;
    const content = fullText.slice(offsetChars, offsetChars + maxChars);
    const hasMore = offsetChars + content.length < totalChars;
    return {
      ok: true,
      fileName: match.fileName,
      projectName: match.projectName,
      absolutePath: match.absolutePath,
      relativePath: match.relativePath,
      totalChars,
      offsetChars,
      returnedChars: content.length,
      hasMore,
      ...(hasMore ? { nextOffsetChars: offsetChars + content.length } : {}),
      content,
    };
  }
  readFile(input: {
    filePath?: string;
    fileQuery?: string;
    projectQuery?: string;
    conversationId?: string;
    offsetChars?: number;
    maxChars?: number;
    callerDomain?: CallerAccessDomain;
  }): ReadAuthorizedFileResult {
    const domain: CallerAccessDomain = input.callerDomain ?? "owner_private";
    const offset = Math.max(0, Math.trunc(input.offsetChars ?? 0));
    const maxChars = Math.max(500, Math.min(24_000, Math.trunc(input.maxChars ?? 12_000)));

    if (input.filePath?.trim()) {
      const absTarget = path.resolve(input.filePath.trim());
      if (isSensitiveFilePath(absTarget)) {
        return { ok: false, errorCode: "SENSITIVE_FILE_BLOCKED", message: "出于凭据与密钥隔离红线，禁止读取该敏感文件。" };
      }
      const allProjectRoots = this.opts.getProjectRoots().filter((r) => fs.existsSync(r.rootPath));
      const matchedRoot = allProjectRoots.find((r) => Boolean(safeRealPathWithin(absTarget, r.rootPath)));
      if (matchedRoot) {
        if (!this.isAllowedForCaller(matchedRoot, domain)) {
          return { ok: false, errorCode: "TIER_0_LOCAL_ONLY", message: "该项目处于私密（仅本机）档位，拒绝向外部域读取正文。" };
        }
        const st = fs.statSync(absTarget);
        return this.readTextSlice({
          fileName: path.basename(absTarget),
          relativePath: path.relative(matchedRoot.rootPath, absTarget).replace(/\\/g, "/"),
          absolutePath: absTarget,
          projectKey: matchedRoot.projectKey,
          projectName: matchedRoot.displayName,
          sourceKind: matchedRoot.sourceKind,
          sizeBytes: st.size,
          modifiedAtIso: new Date(st.mtimeMs).toISOString(),
          mtimeMs: st.mtimeMs,
        }, offset, maxChars, domain);
      }
      if (domain === "owner_private") {
        for (const surf of ["antigravity", "antigravity-cli", "antigravity-ide"]) {
          const brainBase = path.join(this.opts.homeDir, ".gemini", surf, "brain");
          if (fs.existsSync(brainBase) && safeRealPathWithin(absTarget, brainBase)) {
            const st = fs.statSync(absTarget);
            return this.readTextSlice({
              fileName: path.basename(absTarget),
              relativePath: path.relative(brainBase, absTarget).replace(/\\/g, "/"),
              absolutePath: absTarget,
              projectKey: "brain",
              projectName: "Antigravity 制品库",
              sourceKind: "antigravity_brain",
              sizeBytes: st.size,
              modifiedAtIso: new Date(st.mtimeMs).toISOString(),
              mtimeMs: st.mtimeMs,
            }, offset, maxChars, domain);
          }
        }
      }
      const archiveHit = this.opts.ledger?.findArchiveResources("", domain).find((a) => a.localUriOrPath && path.resolve(a.localUriOrPath) === absTarget);
      if (archiveHit && safeRealPathWithin(absTarget, path.dirname(absTarget))) {
        const st = fs.statSync(absTarget);
        return this.readTextSlice({
          fileName: path.basename(absTarget),
          relativePath: path.basename(absTarget),
          absolutePath: absTarget,
          projectKey: "ledger:archive",
          projectName: archiveHit.title || "个人档案库",
          sourceKind: "ledger_archive",
          sizeBytes: st.size,
          modifiedAtIso: new Date(st.mtimeMs).toISOString(),
          mtimeMs: st.mtimeMs,
        }, offset, maxChars, domain);
      }
      return { ok: false, errorCode: "PATH_NOT_AUTHORIZED", message: "目标文件不在已授权的项目、代码仓、制品目录或个人档案库内（或存在非法软链）。" };
    }

    const matches = this.searchFiles({
      query: input.fileQuery,
      projectQuery: input.projectQuery,
      conversationId: input.conversationId,
      callerDomain: domain,
      limit: 8,
    });
    if (matches.length === 0) {
      return { ok: false, errorCode: "FILE_NOT_FOUND", message: `未在已注册项目或制品库中找到匹配「${input.fileQuery ?? ""}」的文件。` };
    }
    return this.readTextSlice(matches[0]!, offset, maxChars, domain);
  }
}
