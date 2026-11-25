import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SuspendedRoundStore, type SuspendedRoundCheckpoint } from "./receipt-protocol.js";
import {
  StewardshipLedger,
  type CommitmentItem,
  type ContextPartition,
  type ResourceEntry,
} from "./stewardship-ledger.js";

export const COLD_START_SINGLE_ACTION_PROMPT =
  "拖入 1 个常用项目/合同文件夹，或转发 1 段待办消息" as const;

export const SUPPORTED_LOCAL_CODING_CLIS = ["claude", "codex", "opencode", "pi"] as const;
export type SupportedCodingCli = (typeof SUPPORTED_LOCAL_CODING_CLIS)[number];

export interface ColdStartReadinessReport {
  needsColdStart: boolean;
  requiresForm: false;
  promptSingleAction: string;
  detectedClis: SupportedCodingCli[];
  hasLiveLlm: boolean;
  executionTier: "live_llm" | "local_cli" | "pure_local_rules";
  ledgerCounts: {
    goals: number;
    commitments: number;
    resources: number;
  };
}

export interface IngestColdStartDropInput {
  ledger: StewardshipLedger;
  suspendedStore: SuspendedRoundStore;
  folderPath?: string;
  forwardedText?: string;
  partition?: ContextPartition;
  nowIso?: string;
}

export interface IngestColdStartDropResult {
  roundId: string;
  sourceKind: "folder" | "forwarded_text";
  partition: ContextPartition;
  resource: ResourceEntry;
  commitment: CommitmentItem;
  checkpoint: SuspendedRoundCheckpoint;
}

export interface CompleteColdStartApprovalInput {
  suspendedStore: SuspendedRoundStore;
  ledger: StewardshipLedger;
  roundId: string;
  approved: boolean;
  decidedBy?: string;
  note?: string;
  nowIso?: string;
}

export interface CompleteColdStartApprovalResult {
  roundId: string;
  approved: boolean;
  alreadyResolved: boolean;
  commitmentStatus: CommitmentItem["status"];
  resumePrompt: string;
}

const IGNORED_SCAN_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  "target",
  ".venv",
  "venv",
  "__pycache__",
]);

const TECH_STACK_DETECTORS: ReadonlyArray<readonly [string, string]> = [
  ["typescript", "TypeScript"],
  ["vitest", "Vitest"],
  ["react", "React"],
  ["next", "Next.js"],
  ["fastify", "Fastify"],
  ["express", "Express"],
  ["playwright", "Playwright"],
];

const WEEKDAY_ISO_MAP: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 7,
  天: 7,
};

function detectBinaryOnPath(bin: string, env: Record<string, string | undefined>): boolean {
  const rawPath = env.PATH ?? env.Path ?? "";
  if (!rawPath) return false;
  for (const dir of rawPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, process.platform === "win32" ? `${bin}.cmd` : bin);
    try {
      const st = fs.statSync(candidate);
      if (st.isFile()) return true;
    } catch {
      // ignore missing path entry
    }
    if (process.platform === "win32") {
      try {
        if (fs.statSync(path.join(dir, `${bin}.exe`)).isFile()) return true;
      } catch {
        // ignore
      }
    }
  }
  return false;
}

export function probeColdStartReadiness(opts: {
  ledger: StewardshipLedger;
  hasLiveLlm?: boolean;
  detectedClis?: string[];
  env?: Record<string, string | undefined>;
  whichFn?: (bin: string) => boolean;
}): ColdStartReadinessReport {
  const snap = opts.ledger.snapshotForCaller("owner_private");
  const needsColdStart =
    snap.commitments.length === 0 && snap.resources.length === 0 && snap.goals.length === 0;
  const env = opts.env ?? process.env;

  const detectedClis = opts.detectedClis
    ? SUPPORTED_LOCAL_CODING_CLIS.filter((c) => opts.detectedClis!.includes(c))
    : SUPPORTED_LOCAL_CODING_CLIS.filter((c) =>
        opts.whichFn ? Boolean(opts.whichFn(c)) : detectBinaryOnPath(c, env),
      );

  const hasLiveLlm =
    opts.hasLiveLlm ??
    ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"].some((k) =>
      Boolean(String(env[k] ?? "").trim()),
    );

  return {
    needsColdStart,
    requiresForm: false,
    promptSingleAction: needsColdStart ? COLD_START_SINGLE_ACTION_PROMPT : "",
    detectedClis,
    hasLiveLlm,
    executionTier: hasLiveLlm ? "live_llm" : detectedClis.length > 0 ? "local_cli" : "pure_local_rules",
    ledgerCounts: {
      goals: snap.goals.length,
      commitments: snap.commitments.length,
      resources: snap.resources.length,
    },
  };
}

function readHeadUtf8(filePath: string, maxBytes = 24_576): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.allocUnsafe(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function extractDueIso(text: string, nowIso: string): string | undefined {
  const full = /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?/.exec(text);
  if (full) {
    const dt = new Date(Date.UTC(Number(full[1]), Number(full[2]) - 1, Number(full[3]), 18, 0, 0));
    if (!Number.isNaN(dt.getTime())) return dt.toISOString();
  }
  const base = Number.isNaN(Date.parse(nowIso)) ? new Date() : new Date(nowIso);
  const baseMs = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 18, 0, 0);
  if (/(?:今天|今日|今晚)/.test(text)) return new Date(baseMs).toISOString();
  if (/(?:明天|明日)/.test(text)) return new Date(baseMs + 86_400_000).toISOString();
  const wk = /(本|这|下)?(?:周|星期|礼拜)([一二三四五六日天])/.exec(text);
  if (wk?.[2]) {
    const targetIso = WEEKDAY_ISO_MAP[wk[2]];
    if (targetIso !== undefined) {
      const curDay = base.getUTCDay() === 0 ? 7 : base.getUTCDay();
      const delta =
        wk[1] === "下"
          ? 7 - curDay + targetIso
          : targetIso >= curDay
            ? targetIso - curDay
            : 7 - (curDay - targetIso);
      return new Date(baseMs + delta * 86_400_000).toISOString();
    }
  }
  return undefined;
}

function scanFolderQuick(folderPath: string, nowIso: string) {
  const abs = path.resolve(folderPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`Cold-start folder not found: ${abs}`);
  }
  const baseName = path.basename(abs) || "project";
  const entries = fs.readdirSync(abs, { withFileTypes: true });
  const files: string[] = [];
  for (const e of entries) {
    if (e.isFile()) files.push(path.join(abs, e.name));
    else if (e.isDirectory() && !e.name.startsWith(".") && !IGNORED_SCAN_DIRS.has(e.name)) {
      try {
        for (const sub of fs.readdirSync(path.join(abs, e.name), { withFileTypes: true }).slice(0, 32)) {
          if (sub.isFile()) files.push(path.join(abs, e.name, sub.name));
        }
      } catch {
        // ignore unreadable subdir
      }
    }
  }

  const stack = new Set<string>();
  let pkgName: string | undefined;
  const pkgPath = path.join(abs, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readHeadUtf8(pkgPath)) as {
        name?: string;
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
      };
      if (pkg.name?.trim()) pkgName = pkg.name.trim();
      const deps = new Set([
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
      ]);
      for (const [k, label] of TECH_STACK_DETECTORS) if (deps.has(k)) stack.add(label);
      if (stack.size === 0) stack.add("Node.js");
    } catch {
      stack.add("Node.js");
    }
  }
  if (fs.existsSync(path.join(abs, "pyproject.toml"))) stack.add("Python");
  if (fs.existsSync(path.join(abs, "Cargo.toml"))) stack.add("Rust");
  if (fs.existsSync(path.join(abs, "go.mod"))) stack.add("Go");

  let h1Title: string | undefined;
  let firstAction: string | undefined;
  const mdFiles = files.filter((f) => /\.(md|txt)$/i.test(f) || /^todo$/i.test(path.basename(f)));
  for (const mf of mdFiles.slice(0, 8)) {
    const txt = readHeadUtf8(mf);
    if (!h1Title && path.basename(mf).toLowerCase() === "readme.md") {
      const m = /^\s*#\s+(.+)$/m.exec(txt);
      if (m?.[1]) h1Title = m[1].replace(/[#`*_]/g, "").trim().slice(0, 60);
    }
    if (!firstAction) {
      const unchecked = /^\s*[-*+]\s*\[\s\]\s+(.+)$/m.exec(txt);
      const todo = /^\s*(?:TODO|NEXT|待办)\s*[:：]\s*(.+)$/im.exec(txt);
      const rawAct = unchecked?.[1] ?? todo?.[1];
      if (rawAct?.trim()) firstAction = rawAct.trim().replace(/\s+/g, " ").slice(0, 120);
    }
  }

  const displayTitle = h1Title || pkgName || baseName;
  const badge = stack.size > 0 ? Array.from(stack).join(", ") : `本地文件 ${files.length} 份`;
  const summary = firstAction || `梳理「${displayTitle}」近期里程碑与优先待办`;
  return {
    resolvedPath: abs,
    resourceTitle: `${displayTitle}（${badge}）`,
    commitmentSummary: summary,
    counterpartyOrRef: pkgName || baseName,
    dueAt: extractDueIso(summary, nowIso),
  };
}

export function ingestColdStartDrop(input: IngestColdStartDropInput): IngestColdStartDropResult {
  const hasFolder = Boolean(input.folderPath?.trim());
  const hasText = Boolean(input.forwardedText?.trim());
  if (!hasFolder && !hasText) {
    throw new Error("ingestColdStartDrop requires folderPath or forwardedText.");
  }

  const nowIso = input.nowIso ?? new Date().toISOString();
  const partition: ContextPartition = input.partition ?? "work_project";
  const hex8 = createHash("sha256")
    .update(`${nowIso}|${input.folderPath ?? ""}|${input.forwardedText ?? ""}|${randomBytes(4).toString("hex")}`)
    .digest("hex")
    .slice(0, 8);
  const roundId = `coldstart-${hex8}`;
  const commitmentId = `cmt-${roundId}`;

  let sourceKind: "folder" | "forwarded_text";
  let resource: ResourceEntry;
  let commitment: CommitmentItem;

  if (hasFolder && input.folderPath) {
    sourceKind = "folder";
    const info = scanFolderQuick(input.folderPath, nowIso);
    resource = input.ledger.upsertResource(
      {
        id: `res-${roundId}`,
        partition,
        kind: "personal_archive",
        title: info.resourceTitle,
        localUriOrPath: info.resolvedPath,
        metadata: { coldStartDemo: true, roundId, commitmentId },
      },
      nowIso,
    );
    commitment = input.ledger.upsertCommitment(
      {
        id: commitmentId,
        partition,
        direction: "i_owe",
        status: "open",
        summary: info.commitmentSummary,
        counterpartyOrRef: info.counterpartyOrRef,
        ...(info.dueAt ? { dueAt: info.dueAt } : {}),
      },
      nowIso,
    );
  } else {
    sourceKind = "forwarded_text";
    const cleaned = String(input.forwardedText ?? "")
      .replace(/^(?:【转发】|\[转发\]|转发\s*[:：]|FW\s*[:：])\s*/i, "")
      .trim();
    const speakerMatch = /^([A-Za-z\u4e00-\u9fa5]{1,12})\s*[:：]\s*(.+)$/s.exec(cleaned);
    const counterparty = speakerMatch?.[1]?.trim() || "转发联系人";
    const body = (speakerMatch?.[2] ?? cleaned).replace(/\s+/g, " ").trim();
    const dueAt = extractDueIso(cleaned, nowIso);

    resource = input.ledger.upsertResource(
      {
        id: `res-${roundId}`,
        partition,
        kind: "personal_archive",
        title: `转发待办摘录：${body.slice(0, 28)}`,
        metadata: { coldStartDemo: true, roundId, commitmentId },
      },
      nowIso,
    );
    commitment = input.ledger.upsertCommitment(
      {
        id: commitmentId,
        partition,
        direction: "i_owe",
        status: "open",
        summary: body.slice(0, 120),
        counterpartyOrRef: counterparty,
        ...(dueAt ? { dueAt } : {}),
      },
      nowIso,
    );
  }

  const checkpoint = input.suspendedStore.suspend({
    roundId,
    sessionId: `sess-${roundId}`,
    parentTrigger: {
      id: `trg-${roundId}`,
      sourceKind: "filesystem",
      sourceInstanceId: "coldstart:dropzone",
      threadKey: `coldstart:${roundId}`,
      senderId: "owner",
      addressedToAgent: true,
      fromAllowedSender: true,
      text: commitment.summary,
      createdAt: nowIso,
      hopCount: 0,
    },
    approval: {
      approvalId: `apr-${roundId}`,
      prompt: `已提炼首条跟进事项「${commitment.summary}」，是否确认办结并归入活账？`,
      riskLevel: "low",
    },
    suspendedAt: nowIso,
  });

  return { roundId, sourceKind, partition, resource, commitment, checkpoint };
}

export function completeColdStartApprovalDemo(
  input: CompleteColdStartApprovalInput,
): CompleteColdStartApprovalResult {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const existing = input.suspendedStore.get(input.roundId);
  if (!existing) {
    throw new Error(`Cold-start round "${input.roundId}" not found.`);
  }
  const commitmentId = `cmt-${input.roundId}`;
  const currentCommit = input.ledger
    .snapshotForCaller("owner_private")
    .commitments.find((c) => c.id === commitmentId);

  if (existing.status === "resumed") {
    return {
      roundId: input.roundId,
      approved: Boolean(existing.decision?.approved),
      alreadyResolved: true,
      commitmentStatus: currentCommit?.status ?? "closed",
      resumePrompt: "",
    };
  }

  const resumed = input.suspendedStore.resume(input.roundId, {
    approved: input.approved,
    decidedBy: input.decidedBy ?? "owner",
    ...(input.note ? { note: input.note } : {}),
    resumedAt: nowIso,
  });

  const nextStatus: CommitmentItem["status"] = input.approved ? "closed" : "open";
  if (currentCommit) {
    input.ledger.upsertCommitment(
      {
        id: currentCommit.id,
        partition: currentCommit.partition,
        direction: currentCommit.direction,
        status: nextStatus,
        summary: currentCommit.summary,
        counterpartyOrRef: currentCommit.counterpartyOrRef,
        ...(currentCommit.dueAt ? { dueAt: currentCommit.dueAt } : {}),
      },
      nowIso,
    );
  }

  return {
    roundId: input.roundId,
    approved: input.approved,
    alreadyResolved: false,
    commitmentStatus: nextStatus,
    resumePrompt: resumed.resumePrompt,
  };
}
