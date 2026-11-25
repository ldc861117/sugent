import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertSafeDeliveryCommandVector } from "./delivery.js";
import { sealExternalEvent } from "./security-envelope.js";

export const CHECKPOINT_REF_PREFIX = "refs/sugent/checkpoints";
const PROTECTED_WORKSPACE_DIRS = [".sugent-handoff", ".worktrees"] as const;
const SAFE_REF_OR_OID_RE = /^[A-Za-z0-9._/-]{1,256}$/;

export interface CreateCheckpointInput {
  workspacePath: string;
  pipelineId: string;
  roundId: string;
  label?: string;
  attemptId?: string;
  nowIso?: string;
}

export interface GitCheckpointRecord {
  ref: string;
  commitSha: string;
  treeSha: string;
  parentCommitSha: string | null;
  pipelineId: string;
  roundId: string;
  label?: string;
  attemptId?: string;
  createdAt: string;
}

export type CheckpointDiffStatus = "A" | "M" | "D";

export interface CheckpointDiffEntry {
  path: string;
  status: CheckpointDiffStatus;
}

export interface RestoreCheckpointInput {
  workspacePath: string;
  targetRef: string;
  pipelineId: string;
}

export interface RestoreCheckpointResult {
  restoredCheckpoint: GitCheckpointRecord;
  preRestoreCheckpoint: GitCheckpointRecord;
  restoredFileCount: number;
  removedFileCount: number;
}

function buildIsolatedGitEnv(indexFile?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  if (indexFile) env.GIT_INDEX_FILE = indexFile;
  else delete env.GIT_INDEX_FILE;
  env.GIT_AUTHOR_NAME = env.GIT_AUTHOR_NAME || "Sugent Checkpoint";
  env.GIT_AUTHOR_EMAIL = env.GIT_AUTHOR_EMAIL || "checkpoint@sugent.local";
  env.GIT_COMMITTER_NAME = env.GIT_COMMITTER_NAME || "Sugent Checkpoint";
  env.GIT_COMMITTER_EMAIL = env.GIT_COMMITTER_EMAIL || "checkpoint@sugent.local";
  env.LC_ALL = "C";
  return env;
}

function runGit(
  workspacePath: string,
  args: readonly string[],
  opts: { indexFile?: string; input?: string | Buffer; allowFailure?: boolean } = {},
): { status: number; stdout: Buffer; stderr: string } {
  const safe = assertSafeDeliveryCommandVector(["git", ...args]);
  const res = spawnSync(safe[0]!, safe.slice(1), {
    cwd: workspacePath,
    env: buildIsolatedGitEnv(opts.indexFile),
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error) throw new Error(`git ${args[0]} failed: ${res.error.message}`);
  const status = res.status ?? 1;
  const stdout = Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.from(res.stdout ?? "", "utf8");
  const stderr = Buffer.isBuffer(res.stderr) ? res.stderr.toString("utf8") : String(res.stderr ?? "");
  if (status !== 0 && !opts.allowFailure) {
    throw new Error(`git ${args.join(" ")} failed (${status}): ${stderr.trim()}`);
  }
  return { status, stdout, stderr };
}

export function toSafeRefSegment(raw: string, field: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error(`Unsafe ${field}: ${raw}`);
  }
  const clean = trimmed.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^\.+|\.+$/g, "").replace(/\.lock$/i, "-lock");
  if (!clean) throw new Error(`Invalid ${field}: ${raw}`);
  return clean.slice(0, 100);
}

function isProtectedRelPath(rel: string): boolean {
  const norm = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  return PROTECTED_WORKSPACE_DIRS.some((d) => norm === d || norm.startsWith(`${d}/`));
}

function resolveHeadSha(ws: string): string | null {
  const r = runGit(ws, ["rev-parse", "--verify", "--quiet", "HEAD"], { allowFailure: true });
  return r.status === 0 ? r.stdout.toString("utf8").trim() || null : null;
}

function captureWorkingTreeSha(ws: string, headSha: string | null): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-idx-"));
  const idxPath = path.join(tmpDir, "index");
  try {
    if (headSha) runGit(ws, ["read-tree", headSha], { indexFile: idxPath });
    runGit(ws, ["add", "-A"], { indexFile: idxPath });
    runGit(ws, ["rm", "--cached", "-r", "--ignore-unmatch", "--", ...PROTECTED_WORKSPACE_DIRS], {
      indexFile: idxPath,
      allowFailure: true,
    });
    return runGit(ws, ["write-tree"], { indexFile: idxPath }).stdout.toString("utf8").trim();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function parseCheckpointCommit(ws: string, ref: string, commitSha: string): GitCheckpointRecord {
  const raw = runGit(ws, ["cat-file", "commit", commitSha]).stdout.toString("utf8");
  const sep = raw.indexOf("\n\n");
  const header = sep >= 0 ? raw.slice(0, sep) : raw;
  const body = sep >= 0 ? raw.slice(sep + 2).trim() : "";
  let treeSha = "";
  let parentCommitSha: string | null = null;
  for (const line of header.split("\n")) {
    if (line.startsWith("tree ")) treeSha = line.slice(5).trim();
    else if (line.startsWith("parent ") && !parentCommitSha) parentCommitSha = line.slice(7).trim();
  }
  const suffix = ref.replace(`${CHECKPOINT_REF_PREFIX}/`, "");
  const slash = suffix.indexOf("/");
  let pipelineId = slash >= 0 ? suffix.slice(0, slash) : "default";
  let roundId = slash >= 0 ? suffix.slice(slash + 1) : suffix;
  let label: string | undefined;
  let attemptId: string | undefined;
  let createdAt = new Date(0).toISOString();
  try {
    const meta = JSON.parse(body) as Record<string, unknown>;
    if (typeof meta.pipelineId === "string") pipelineId = meta.pipelineId;
    if (typeof meta.roundId === "string") roundId = meta.roundId;
    if (typeof meta.label === "string") label = meta.label;
    if (typeof meta.attemptId === "string") attemptId = meta.attemptId;
    if (typeof meta.createdAt === "string") createdAt = meta.createdAt;
  } catch {
    // ignore non-json body
  }
  return {
    ref,
    commitSha,
    treeSha,
    parentCommitSha,
    pipelineId,
    roundId,
    ...(label !== undefined ? { label } : {}),
    ...(attemptId !== undefined ? { attemptId } : {}),
    createdAt,
  };
}

export class GitRefCheckpointManager {
  createCheckpoint(input: CreateCheckpointInput): GitCheckpointRecord {
    const ws = path.resolve(input.workspacePath);
    const safePipe = toSafeRefSegment(input.pipelineId, "pipelineId");
    const safeRound = toSafeRefSegment(input.roundId, "roundId");
    const createdAt = input.nowIso ?? new Date().toISOString();
    const headSha = resolveHeadSha(ws);
    const treeSha = captureWorkingTreeSha(ws, headSha);
    const metaJson = JSON.stringify({
      schemaVersion: 1,
      pipelineId: input.pipelineId,
      roundId: input.roundId,
      ...(input.label ? { label: input.label } : {}),
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      createdAt,
    });
    const commitArgs = headSha ? ["commit-tree", treeSha, "-p", headSha] : ["commit-tree", treeSha];
    const commitSha = runGit(ws, commitArgs, { input: `${metaJson}\n` }).stdout.toString("utf8").trim();
    const ref = `${CHECKPOINT_REF_PREFIX}/${safePipe}/${safeRound}`;
    runGit(ws, ["update-ref", ref, commitSha]);
    return {
      ref,
      commitSha,
      treeSha,
      parentCommitSha: headSha,
      pipelineId: input.pipelineId,
      roundId: input.roundId,
      ...(input.label ? { label: input.label } : {}),
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      createdAt,
    };
  }

  listCheckpoints(workspacePath: string, pipelineId?: string): GitCheckpointRecord[] {
    const ws = path.resolve(workspacePath);
    const prefix = pipelineId
      ? `${CHECKPOINT_REF_PREFIX}/${toSafeRefSegment(pipelineId, "pipelineId")}`
      : CHECKPOINT_REF_PREFIX;
    const out = runGit(ws, ["for-each-ref", prefix]).stdout.toString("utf8").trim();
    if (!out) return [];
    const records: GitCheckpointRecord[] = [];
    for (const line of out.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const sha = line.slice(0, tab).trim().split(/\s+/)[0] ?? "";
      const ref = line.slice(tab + 1).trim();
      if (sha && ref) records.push(parseCheckpointCommit(ws, ref, sha));
    }
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.ref.localeCompare(b.ref));
  }

  private resolveTargetSha(ws: string, refOrSha: string): string | null {
    const clean = refOrSha.trim();
    if (!SAFE_REF_OR_OID_RE.test(clean) || clean.startsWith("-") || clean.includes("..")) return null;
    const r = runGit(ws, ["rev-parse", "--verify", "--quiet", clean], { allowFailure: true });
    return r.status === 0 ? r.stdout.toString("utf8").trim() || null : null;
  }

  diffCheckpoints(workspacePath: string, fromRefOrSha: string, toRefOrSha?: string): CheckpointDiffEntry[] {
    const ws = path.resolve(workspacePath);
    const fromSha = this.resolveTargetSha(ws, fromRefOrSha);
    if (!fromSha) throw new Error(`Unknown checkpoint ref: ${fromRefOrSha}`);
    const toSha = toRefOrSha
      ? this.resolveTargetSha(ws, toRefOrSha)
      : captureWorkingTreeSha(ws, resolveHeadSha(ws));
    if (!toSha) throw new Error(`Unknown target ref: ${String(toRefOrSha)}`);
    if (fromSha === toSha) return [];
    const raw = runGit(ws, ["diff-tree", "-r", "-z", "--no-renames", "--name-status", fromSha, toSha]).stdout.toString("utf8");
    const parts = raw.split("\0");
    const entries: CheckpointDiffEntry[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const st = parts[i] ?? "";
      const fp = parts[i + 1] ?? "";
      if (!st || !fp || isProtectedRelPath(fp)) continue;
      entries.push({ path: fp, status: st[0] === "A" ? "A" : st[0] === "D" ? "D" : "M" });
    }
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }

  restoreCheckpoint(input: RestoreCheckpointInput): RestoreCheckpointResult {
    const ws = path.resolve(input.workspacePath);
    const safePipe = toSafeRefSegment(input.pipelineId, "pipelineId");
    const candidateRef = input.targetRef.startsWith("refs/")
      ? input.targetRef.trim()
      : `${CHECKPOINT_REF_PREFIX}/${safePipe}/${toSafeRefSegment(input.targetRef, "targetRef")}`;
    const targetSha = this.resolveTargetSha(ws, candidateRef) ?? this.resolveTargetSha(ws, input.targetRef);
    if (!targetSha) throw new Error(`Target checkpoint not found: ${input.targetRef}`);
    const resolvedRef = this.resolveTargetSha(ws, candidateRef) ? candidateRef : input.targetRef.trim();

    const preRestoreCheckpoint = this.createCheckpoint({
      workspacePath: ws,
      pipelineId: input.pipelineId,
      roundId: `pre-restore-${Date.now()}`,
      label: `Auto backup before restoring ${resolvedRef}`,
    });

    const diffFromTargetToCurrent = this.diffCheckpoints(ws, targetSha);
    let removedFileCount = 0;
    for (const d of diffFromTargetToCurrent) {
      if (d.status === "A" && !isProtectedRelPath(d.path)) {
        const abs = path.join(ws, d.path);
        if (fs.existsSync(abs)) {
          fs.rmSync(abs, { recursive: true, force: true });
          removedFileCount += 1;
        }
      }
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-restore-idx-"));
    const idxPath = path.join(tmpDir, "index");
    let restoredFileCount = 0;
    try {
      runGit(ws, ["read-tree", targetSha], { indexFile: idxPath });
      runGit(ws, ["rm", "--cached", "-r", "--ignore-unmatch", "--", ...PROTECTED_WORKSPACE_DIRS], {
        indexFile: idxPath,
        allowFailure: true,
      });
      const ls = runGit(ws, ["ls-files", "-z"], { indexFile: idxPath }).stdout.toString("utf8");
      const files = ls.split("\0").filter((f) => f && !isProtectedRelPath(f));
      if (files.length > 0) {
        runGit(ws, ["checkout-index", "-f", "-a"], { indexFile: idxPath });
        restoredFileCount = files.length;
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    return {
      restoredCheckpoint: parseCheckpointCommit(ws, resolvedRef, targetSha),
      preRestoreCheckpoint,
      restoredFileCount,
      removedFileCount,
    };
  }
}

export interface PrReviewComment {
  path: string;
  line?: number;
  author?: string;
  body: string;
}

export function stagePrReviewToHandoff(input: {
  workspacePath: string;
  roundId: string;
  repoSlug: string;
  prNumber: number;
  ciFailureLog?: string;
  comments?: PrReviewComment[];
  rawUntrustedPayload?: Record<string, unknown>;
}) {
  const ws = path.resolve(input.workspacePath);
  const safeRound = toSafeRefSegment(input.roundId, "roundId");
  const safeRepoToken = input.repoSlug.replace(/[^A-Za-z0-9._:/#@+-]+/g, "-");
  const eventId = `pr-${Math.max(1, Math.trunc(input.prNumber))}-${safeRound}`;
  const rawBodyLines: string[] = [];
  if (input.ciFailureLog?.trim()) {
    rawBodyLines.push("## CI Failure Log", input.ciFailureLog.trim(), "");
  }
  if (input.comments?.length) {
    rawBodyLines.push("## Inline Diff Comments");
    input.comments.forEach((c, idx) => {
      rawBodyLines.push(`${idx + 1}. [${c.path}${c.line ? `:${c.line}` : ""}] (${c.author || "reviewer"}): ${c.body}`);
    });
  }

  const sealed = sealExternalEvent({
    workspaceDir: ws,
    source: `github:${safeRepoToken}`,
    eventType: "pull_request_review",
    eventId,
    title: `PR #${input.prNumber} Review & CI Feedback`,
    body: rawBodyLines.join("\n"),
    payload: {
      ...(input.rawUntrustedPayload ?? {}),
      prNumber: input.prNumber,
      commentCount: input.comments?.length ?? 0,
    },
    privilegedFieldMode: "strip",
  });

  const inboxDir = path.join(ws, ".sugent-handoff", "inbox", safeRound);
  fs.mkdirSync(inboxDir, { recursive: true });
  const specFilePath = path.join(inboxDir, "PR_REVIEW_SPEC.md");
  const indexedComments = (input.comments ?? []).map((c, index) => ({
    index: index + 1,
    path: c.path.replace(/[\r\n`]/g, ""),
    ...(typeof c.line === "number" ? { line: c.line } : {}),
    ...(c.author ? { author: c.author.replace(/[^A-Za-z0-9._@-]/g, "") } : {}),
  }));

  const specLines = [
    `# PR #${input.prNumber} 增量修复任务单 (${safeRound})`,
    "",
    sealed.prompt,
    "",
    "## 结构化定位索引（原始评论与日志已物理隔离于上述只读 context 文件）",
    `- CI 失败日志：${input.ciFailureLog?.trim() ? "包含" : "无"}`,
    ...indexedComments.map((c) => `- 评论 #${c.index}：\`${c.path}${c.line ? `:${c.line}` : ""}\``),
    "",
  ];
  fs.writeFileSync(specFilePath, specLines.join("\n"), "utf8");

  return {
    roundId: safeRound,
    specFilePath,
    specRelativePath: path.relative(ws, specFilePath),
    envelope: sealed.envelope,
    envelopeFilePath: sealed.envelope.absoluteFilePath,
    promptInstruction: sealed.prompt,
    strippedFields: sealed.envelope.strippedFields ?? [],
    indexedComments,
    hasCiFailureLog: Boolean(input.ciFailureLog?.trim()),
  };
}

export function buildDomElementPickSpec(input: {
  pageUrl: string;
  selector: string;
  tagName: string;
  boundingBox?: { x: number; y: number; width: number; height: number };
  textPreview?: string;
  screenshotPath?: string;
  userInstruction: string;
}) {
  const cleanSelector = input.selector.trim();
  const cleanTag = input.tagName.trim().toLowerCase() || "div";
  const boxText = input.boundingBox
    ? `${input.boundingBox.width}x${input.boundingBox.height} @ (${input.boundingBox.x}, ${input.boundingBox.y})`
    : "unspecified";
  const summaryLines = [
    "## 前端元素点选修改任务",
    `- 页面：\`${input.pageUrl.trim()}\``,
    `- 目标选择器：\`${cleanSelector}\` (\`<${cleanTag}>\`)`,
    `- 几何位置：${boxText}`,
    ...(input.textPreview ? [`- 文本预览：${input.textPreview.trim().slice(0, 80)}`] : []),
    ...(input.screenshotPath ? [`- 截图附件：\`${input.screenshotPath}\``] : []),
    `- 修改要求：${input.userInstruction.trim()}`,
  ];
  return {
    kind: "sugent.dom-element-pick.v1" as const,
    target: {
      pageUrl: input.pageUrl.trim(),
      selector: cleanSelector,
      tagName: cleanTag,
      ...(input.boundingBox ? { boundingBox: input.boundingBox } : {}),
      ...(input.textPreview ? { textPreview: input.textPreview.trim().slice(0, 120) } : {}),
      ...(input.screenshotPath ? { screenshotPath: input.screenshotPath } : {}),
    },
    userInstruction: input.userInstruction.trim(),
    markdownSummary: summaryLines.join("\n"),
  };
}
