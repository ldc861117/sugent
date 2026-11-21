import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalizeProjectKey } from "./antigravity-bridge.js";
import type { AntigravityDispatcher, DispatchOutcome } from "./antigravity-dispatcher.js";
import { assertSafeDeliveryCommandVector } from "./delivery.js";
import { discoverLocalSourceRepo } from "./self-evolution.js";

export type CodingBackendKind = "antigravity" | "claude_code" | "codex";
export type RepoRestartMode = "none" | "extension_hotplug" | "process_reload" | "blue_green_app";

export interface RepoBindingRecord {
  bindingId: string;
  alias: string;
  keywords: string[];
  repoRoot: string;
  projectKey: string;
  defaultBranch: string;
  codingBackend: CodingBackendKind;
  pinnedConversationId?: string;
  verifyArgv?: string[];
  smokeArgv?: string[];
  buildArgv?: string[];
  packageArgv?: string[];
  stagingAppRelPath?: string;
  targetAppBundlePath?: string;
  restartMode: RepoRestartMode;
  isSelfRepo?: boolean;
  updatedAtIso: string;
}

export interface UpsertRepoBindingInput {
  bindingId?: string;
  alias: string;
  keywords?: string[];
  repoRoot: string;
  defaultBranch?: string;
  codingBackend?: CodingBackendKind;
  pinnedConversationId?: string;
  verifyArgv?: string[];
  smokeArgv?: string[];
  buildArgv?: string[];
  packageArgv?: string[];
  stagingAppRelPath?: string;
  targetAppBundlePath?: string;
  restartMode?: RepoRestartMode;
  isSelfRepo?: boolean;
}

function writeJsonAtomic600(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, filePath);
}

function execArgv(argv: readonly string[], cwd: string, timeoutMs = 30_000): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const safeArgv = assertSafeDeliveryCommandVector(argv);
  return new Promise((resolve) => {
    execFile(safeArgv[0], safeArgv.slice(1), { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? Number((err as { code: number }).code) : err ? 1 : 0;
      resolve({ exitCode: code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

function readGitRemoteUrl(repoRoot: string): string | undefined {
  try {
    const cfgPath = path.join(repoRoot, ".git", "config");
    if (!fs.existsSync(cfgPath)) return undefined;
    const match = /^\s*url\s*=\s*(.+?)\s*$/m.exec(fs.readFileSync(cfgPath, "utf8"));
    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
}

export function ensureGitExcludeEntry(workspaceRoot: string, pattern = ".sugent-handoff/"): { updated: boolean; excludeFile?: string } {
  const dotGit = path.join(path.resolve(workspaceRoot), ".git");
  if (!fs.existsSync(dotGit)) return { updated: false };
  let gitDir: string | undefined;
  try {
    const stat = fs.statSync(dotGit);
    if (stat.isDirectory()) {
      gitDir = dotGit;
    } else if (stat.isFile()) {
      const text = fs.readFileSync(dotGit, "utf8");
      const m = /^\s*gitdir:\s*(.+?)\s*$/m.exec(text);
      if (m?.[1]) {
        const wtGitDir = path.resolve(workspaceRoot, m[1].trim());
        const commonFile = path.join(wtGitDir, "commondir");
        if (fs.existsSync(commonFile)) {
          const rel = fs.readFileSync(commonFile, "utf8").trim();
          gitDir = path.resolve(wtGitDir, rel);
        } else {
          gitDir = wtGitDir;
        }
      }
    }
  } catch {
    return { updated: false };
  }
  if (!gitDir) return { updated: false };
  const excludeFile = path.join(gitDir, "info", "exclude");
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
  const existing = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, "utf8") : "";
  const lines = existing.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(pattern)) return { updated: false, excludeFile };
  const next = `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${pattern}\n`;
  fs.writeFileSync(excludeFile, next, "utf8");
  return { updated: true, excludeFile };
}

function slugifyId(raw: string): string {
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return slug || `repo-${crypto.randomBytes(3).toString("hex")}`;
}

export class RepoBindingRegistry {
  readonly filePath: string;
  private readonly nowIsoFn: () => string;
  private bindings = new Map<string, RepoBindingRecord>();

  constructor(opts: { dataDir: string; nowIso?: () => string }) {
    this.filePath = path.join(path.resolve(opts.dataDir), "sugent-stewardship", "repo-bindings.json");
    this.nowIsoFn = opts.nowIso ?? (() => new Date().toISOString());
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as { bindings?: RepoBindingRecord[] };
      for (const rec of parsed.bindings ?? []) {
        if (rec?.bindingId && rec?.repoRoot) this.bindings.set(rec.bindingId, rec);
      }
    } catch {
      // ignore corrupted binding store
    }
  }

  private save(): void {
    writeJsonAtomic600(this.filePath, { bindings: this.listBindings() });
  }

  listBindings(): RepoBindingRecord[] {
    return Array.from(this.bindings.values()).sort((a, b) => Number(Boolean(b.isSelfRepo)) - Number(Boolean(a.isSelfRepo)) || b.updatedAtIso.localeCompare(a.updatedAtIso));
  }

  getBinding(idOrQuery?: string): RepoBindingRecord | undefined {
    const all = this.listBindings();
    if (!idOrQuery?.trim()) return all.length === 1 ? all[0] : undefined;
    const q = idOrQuery.trim().toLowerCase();
    return (
      this.bindings.get(idOrQuery.trim()) ??
      all.find((b) => b.alias.toLowerCase() === q || path.basename(b.repoRoot).toLowerCase() === q) ??
      all.find((b) => [b.alias, b.projectKey, path.basename(b.repoRoot), ...b.keywords].some((k) => k && (k.toLowerCase().includes(q) || q.includes(k.toLowerCase()))))
    );
  }
  upsertBinding(input: UpsertRepoBindingInput): RepoBindingRecord {
    const repoRoot = path.resolve(input.repoRoot);
    if (!fs.existsSync(repoRoot) || !fs.statSync(repoRoot).isDirectory()) {
      throw new Error(`绑定失败：目录不存在 ${repoRoot}`);
    }
    const bindingId = input.bindingId?.trim() || (input.isSelfRepo ? "repo-sugent-self" : `repo-${slugifyId(input.alias || path.basename(repoRoot))}`);
    const remoteUrl = readGitRemoteUrl(repoRoot);
    const projectKey = canonicalizeProjectKey({ folderPath: repoRoot, remoteUrl });
    const record: RepoBindingRecord = {
      bindingId,
      alias: input.alias.trim() || path.basename(repoRoot),
      keywords: Array.from(new Set([input.alias.trim(), path.basename(repoRoot), ...(input.keywords ?? [])].filter(Boolean))),
      repoRoot,
      projectKey,
      defaultBranch: input.defaultBranch?.trim() || "main",
      codingBackend: input.codingBackend ?? "antigravity",
      restartMode: input.restartMode ?? "none",
      ...(input.pinnedConversationId?.trim() ? { pinnedConversationId: input.pinnedConversationId.trim() } : {}),
      ...(input.verifyArgv?.length ? { verifyArgv: [...input.verifyArgv] } : {}),
      ...(input.smokeArgv?.length ? { smokeArgv: [...input.smokeArgv] } : {}),
      ...(input.buildArgv?.length ? { buildArgv: [...input.buildArgv] } : {}),
      ...(input.packageArgv?.length ? { packageArgv: [...input.packageArgv] } : {}),
      ...(input.stagingAppRelPath?.trim() ? { stagingAppRelPath: input.stagingAppRelPath.trim() } : {}),
      ...(input.targetAppBundlePath?.trim() ? { targetAppBundlePath: path.resolve(input.targetAppBundlePath.trim()) } : {}),
      ...(input.isSelfRepo ? { isSelfRepo: true } : {}),
      updatedAtIso: this.nowIsoFn(),
    };
    this.bindings.set(bindingId, record);
    this.save();
    return record;
  }

  removeBinding(bindingId: string): boolean {
    const deleted = this.bindings.delete(bindingId);
    if (deleted) this.save();
    return deleted;
  }

  bindSugentSelfRepo(opts: { repoRoot?: string; targetAppBundlePath?: string; pinnedConversationId?: string } = {}): RepoBindingRecord {
    const detected = opts.repoRoot ? path.resolve(opts.repoRoot) : discoverLocalSourceRepo();
    if (!detected) {
      throw new Error("未在本机自动探测到 Sugent 源码仓库，请手动传入源码目录路径。");
    }
    const hasTargetApp = Boolean(opts.targetAppBundlePath?.trim());
    return this.upsertBinding({
      bindingId: "repo-sugent-self",
      alias: "Sugent 自身源码",
      keywords: ["sugent", "自己", "自身", "桌面端", "app", "管家"],
      repoRoot: detected,
      defaultBranch: "main",
      codingBackend: "antigravity",
      verifyArgv: ["npm", "run", "verify:sugent"],
      smokeArgv: ["npm", "run", "electron:smoke"],
      buildArgv: ["npm", "run", "build"],
      packageArgv: ["npx", "electron-builder", "--mac", "dir", "--arm64"],
      stagingAppRelPath: "release/mac-arm64/Sugent.app",
      ...(hasTargetApp ? { targetAppBundlePath: opts.targetAppBundlePath } : {}),
      ...(opts.pinnedConversationId ? { pinnedConversationId: opts.pinnedConversationId } : {}),
      restartMode: hasTargetApp ? "blue_green_app" : "process_reload",
      isSelfRepo: true,
    });
  }
}

export interface PreparedWorkspaceResult {
  worktreePath: string;
  branchName?: string;
  baseHeadSha?: string;
  isolatedWorktree: boolean;
}
export class GitWorktreeManager {
  async prepareWorktree(input: {
    binding: RepoBindingRecord;
    taskId: string;
    worktreesRootDir?: string;
    useInPlaceWorkspace?: boolean;
  }): Promise<PreparedWorkspaceResult> {
    const repoRoot = path.resolve(input.binding.repoRoot);
    const hasGit = fs.existsSync(path.join(repoRoot, ".git"));
    if (!hasGit || input.useInPlaceWorkspace) {
      ensureGitExcludeEntry(repoRoot);
      return { worktreePath: repoRoot, isolatedWorktree: false };
    }
    const baseCandidates = [input.binding.defaultBranch, "HEAD"];
    let baseRef = "HEAD";
    let baseHeadSha: string | undefined;
    for (const candidate of baseCandidates) {
      const check = await execArgv(["git", "rev-parse", "--verify", candidate], repoRoot);
      if (check.exitCode === 0 && check.stdout.trim()) {
        baseRef = candidate;
        baseHeadSha = check.stdout.trim().split(/\s+/)[0];
        break;
      }
    }
    if (!baseHeadSha) {
      ensureGitExcludeEntry(repoRoot);
      return { worktreePath: repoRoot, isolatedWorktree: false };
    }
    const rootDir = input.worktreesRootDir
      ? path.resolve(input.worktreesRootDir)
      : path.join(repoRoot, ".worktrees");
    ensureGitExcludeEntry(repoRoot, ".worktrees/");
    const safeTaskId = slugifyId(input.taskId);
    const worktreePath = path.join(rootDir, input.binding.bindingId, safeTaskId);
    const branchName = `sugent/vibe-${safeTaskId}`;
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    if (fs.existsSync(worktreePath)) {
      await this.cleanupWorktree({ repoRoot, worktreePath });
    }
    const addRes = await execArgv(["git", "worktree", "add", "-B", branchName, worktreePath, baseRef], repoRoot);
    if (addRes.exitCode !== 0) {
      throw new Error(`创建隔离 Git Worktree 失败: ${addRes.stderr || addRes.stdout}`);
    }
    ensureGitExcludeEntry(worktreePath);
    return { worktreePath, branchName, baseHeadSha, isolatedWorktree: true };
  }

  async cleanupWorktree(input: { repoRoot: string; worktreePath: string }): Promise<boolean> {
    const res = await execArgv(["git", "worktree", "remove", "--force", path.resolve(input.worktreePath)], path.resolve(input.repoRoot));
    return res.exitCode === 0;
  }

  async listChangedFiles(workspaceRoot: string): Promise<string[]> {
    const abs = path.resolve(workspaceRoot);
    if (!fs.existsSync(path.join(abs, ".git"))) return [];
    const res = await execArgv(["git", "status", "--porcelain"], abs);
    if (res.exitCode !== 0) return [];
    return res.stdout
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 3)
      .map((line) => line.slice(3).trim().replace(/^"|"$/g, ""));
  }
}

export function ensureVibeWorkerSkill(workspaceRoot: string): string {
  const skillDir = path.join(path.resolve(workspaceRoot), ".agents", "skills", "sugent-vibe-worker");
  const skillFile = path.join(skillDir, "SKILL.md");
  fs.mkdirSync(skillDir, { recursive: true });
  const content = [
    "---",
    "name: sugent-vibe-worker",
    "description: Two-phase engineering collaboration protocol between Sugent Steward and local coding agent.",
    "---",
    "",
    "# Sugent Vibe Coding 协作协议",
    "",
    "1. **第一阶段（仅调研出 Plan，禁止直接改生产代码）**：使用 `read_file` 阅读 `.sugent-handoff/inbox/<roundId>/SPEC_MANIFEST.md` 及同目录下所有附件；只读探索代码库并写出修改计划（`implementation_plan.md` 或 `.sugent-handoff/outbox/<roundId>/PLAN.md`），然后调用 `steward_request_owner_approval` 或正常结束本轮等待主人拍板。",
    "2. **第二阶段（编码与自测）**：收到批准后在当前工作区编码并运行本地测试；将验收截图、构建产物报告写入 `.sugent-handoff/outbox/<roundId>/`，并调用 `steward_report_milestone` 提交产物路径。",
    "",
  ].join("\n");
  fs.writeFileSync(skillFile, content, "utf8");
  ensureGitExcludeEntry(workspaceRoot, ".agents/skills/sugent-vibe-worker/");
  return skillFile;
}

export interface CodingDispatchRequest {
  workspacePath: string;
  prompt: string;
  title: string;
  conversationId?: string;
  model?: string;
  hopCount?: number;
}

export interface CodingHarnessPort {
  readonly backend: CodingBackendKind;
  dispatchPhasePrompt(input: CodingDispatchRequest): Promise<DispatchOutcome>;
}

export class AntigravityCodingHarness implements CodingHarnessPort {
  readonly backend: CodingBackendKind = "antigravity";

  constructor(private readonly dispatcher: AntigravityDispatcher) {}

  async dispatchPhasePrompt(input: CodingDispatchRequest): Promise<DispatchOutcome> {
    if (input.conversationId?.trim()) {
      const resumed = await this.dispatcher.resumeSession({
        conversationId: input.conversationId.trim(),
        content: input.prompt,
        title: input.title,
        hopCount: input.hopCount,
      });
      if (resumed.ok || resumed.errorCode === "HOP_CIRCUIT_BROKEN") {
        return resumed;
      }
    }
    return this.dispatcher.startNewSession({
      prompt: input.prompt,
      workspacePath: input.workspacePath,
      title: input.title,
      ...(input.model ? { model: input.model } : {}),
      hopCount: input.hopCount,
    });
  }
}

export class CodingHarnessRegistry {
  private readonly adapters = new Map<CodingBackendKind, CodingHarnessPort>();

  constructor(initial: CodingHarnessPort[] = []) {
    for (const adapter of initial) this.register(adapter);
  }

  register(adapter: CodingHarnessPort): void {
    this.adapters.set(adapter.backend, adapter);
  }

  get(backend: CodingBackendKind): CodingHarnessPort | undefined {
    return this.adapters.get(backend);
  }

  listBackends(): CodingBackendKind[] {
    return Array.from(this.adapters.keys());
  }
}
