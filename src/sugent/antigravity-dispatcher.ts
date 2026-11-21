import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { looksSecret } from "../agent/memory.js";
import type { ProjectPrivacyRegistry } from "./antigravity-bridge.js";
export type PrivacySovereigntyTier = "local_only" | "metadata_only" | "summary_allowed";
import type { CausalLedger } from "./causal-ledger.js";
import { DEFAULT_MAX_HOPS, deriveChildTriggerHop, evaluatePersonalTrigger } from "./kernel.js";
import type { PersonalTrigger } from "./types.js";

export interface AgentApiMetadataResult {
  exists: boolean;
  killed?: boolean;
  rootConversationId?: string;
  parentConversationId?: string;
  nestingDepth?: number;
  workspaceUris?: string[];
}

export interface AgentApiRunner {
  getConversationMetadata(conversationId: string): Promise<AgentApiMetadataResult>;
  sendMessage(params: { recipientId: string; content: string; title?: string }): Promise<{ ok: boolean; exitCode: number }>;
  newConversation(params: {
    prompt: string;
    model?: "flash_lite" | "flash" | "pro" | string;
    title?: string;
    profile?: string;
    cwd?: string;
  }): Promise<{ conversationId?: string; exitCode: number }>;
}

function runExecFile(
  binPath: string,
  args: string[],
  timeoutMs = 20_000,
  cwd?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      binPath,
      args,
      { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, ...(cwd ? { cwd } : {}) },
      (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? Number((err as { code: number }).code) : err ? 1 : 0;
      resolve({ exitCode: code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

export function createExecFileAgentApiRunner(
  binPath = path.join(os.homedir(), ".gemini", "antigravity", "bin", "agentapi"),
): AgentApiRunner {
  return {
    async getConversationMetadata(conversationId: string): Promise<AgentApiMetadataResult> {
      const res = await runExecFile(binPath, ["get-conversation-metadata", conversationId]);
      if (res.exitCode !== 0 || !res.stdout.trim()) return { exists: false };
      try {
        const parsed = JSON.parse(res.stdout) as {
          response?: { conversationMetadata?: { metadata?: Record<string, unknown> } };
        };
        const meta = parsed.response?.conversationMetadata?.metadata;
        if (!meta) return { exists: false };
        return {
          exists: true,
          ...(typeof meta.rootConversationId === "string" ? { rootConversationId: meta.rootConversationId } : {}),
          ...(typeof meta.parentConversationId === "string" ? { parentConversationId: meta.parentConversationId } : {}),
          ...(typeof meta.nestingDepth === "number" ? { nestingDepth: meta.nestingDepth } : {}),
          ...(Array.isArray(meta.workspaceUris) ? { workspaceUris: meta.workspaceUris.map(String) } : {}),
        };
      } catch {
        return { exists: false };
      }
    },
    async sendMessage(params): Promise<{ ok: boolean; exitCode: number }> {
      const args = ["send-message", ...(params.title ? [`--title=${params.title}`] : []), params.recipientId, params.content];
      const res = await runExecFile(binPath, args);
      return { ok: res.exitCode === 0, exitCode: res.exitCode };
    },
    async newConversation(params): Promise<{ conversationId?: string; exitCode: number }> {
      const args = [
        "new-conversation",
        ...(params.model ? [`--model=${params.model}`] : []),
        ...(params.title ? [`--title=${params.title}`] : []),
        ...(params.profile ? [`--profile=${params.profile}`] : []),
        "--",
        params.prompt,
      ];
      const res = await runExecFile(binPath, args, 20_000, params.cwd);
      const idMatch = res.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      return { ...(idMatch?.[0] ? { conversationId: idMatch[0] } : {}), exitCode: res.exitCode };
    },
  };
}
function uriToFsPath(uriOrPath: string): string {
  const trimmed = uriOrPath.trim();
  if (trimmed.startsWith("file://")) {
    try {
      return path.resolve(fileURLToPath(trimmed));
    } catch {
      return path.resolve(trimmed.slice(7));
    }
  }
  return path.resolve(trimmed);
}

export function loadSidecarAllowedWorkspaces(sidecarsDir: string): string[] {
  const roots: string[] = [];
  if (!fs.existsSync(sidecarsDir)) return roots;
  try {
    for (const entry of fs.readdirSync(sidecarsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sidecarFile = path.join(sidecarsDir, entry.name, "sidecar.json");
      if (!fs.existsSync(sidecarFile)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(sidecarFile, "utf8")) as {
          workspace_uris?: unknown;
          agent_permissions?: { workspace_uris?: unknown };
        };
        const rawUris = [
          ...(Array.isArray(parsed.agent_permissions?.workspace_uris) ? parsed.agent_permissions.workspace_uris : []),
          ...(Array.isArray(parsed.workspace_uris) ? parsed.workspace_uris : []),
        ];
        for (const u of rawUris) {
          if (typeof u === "string" && u.trim()) roots.push(uriToFsPath(u));
        }
      } catch {
        // ignore single malformed sidecar
      }
    }
  } catch {
    return roots;
  }
  return Array.from(new Set(roots));
}

export interface AntigravityDispatcherOptions {
  runner?: AgentApiRunner;
  binPath?: string;
  causalLedger?: CausalLedger;
  allowedWorkspaceRoots?: string[];
  sidecarsDir?: string;
  maxHops?: number;
  nowIso?: () => string;
}

export interface DispatchOutcome {
  ok: boolean;
  roundId: string;
  hopCount: number;
  maxHops: number;
  conversationId?: string;
  errorCode?: "HOP_CIRCUIT_BROKEN" | "SESSION_UNAVAILABLE" | "SUBAGENT_DISPATCH_FORBIDDEN" | "WORKSPACE_NOT_ALLOWED" | "AGENTAPI_FAILED";
  message?: string;
}

export class AntigravityDispatcher {
  private readonly runner: AgentApiRunner;
  private readonly maxHops: number;
  private readonly nowIsoFn: () => string;

  constructor(private readonly opts: AntigravityDispatcherOptions = {}) {
    this.runner = opts.runner ?? createExecFileAgentApiRunner(opts.binPath);
    this.maxHops = opts.maxHops ?? DEFAULT_MAX_HOPS;
    this.nowIsoFn = opts.nowIso ?? (() => new Date().toISOString());
  }

  private allowedRoots(): string[] {
    const explicit = (this.opts.allowedWorkspaceRoots ?? []).map((p) => uriToFsPath(p));
    const sidecarRoots = this.opts.sidecarsDir ? loadSidecarAllowedWorkspaces(this.opts.sidecarsDir) : [];
    return Array.from(new Set([...explicit, ...sidecarRoots]));
  }

  private isWorkspaceAllowed(targetUriOrPath: string): boolean {
    const roots = this.allowedRoots();
    if (roots.length === 0) return true;
    const candidate = uriToFsPath(targetUriOrPath);
    return roots.some((r) => candidate === r || candidate.startsWith(`${r}${path.sep}`));
  }
  private checkHopGate(roundId: string, threadKey: string, text: string, input: { hopCount?: number; parentTrigger?: PersonalTrigger }): DispatchOutcome | null {
    const nowIso = this.nowIsoFn();
    const hopMeta = input.parentTrigger
      ? deriveChildTriggerHop(input.parentTrigger)
      : { hopCount: input.hopCount ?? 0, originTriggerId: roundId };
    const trigger: PersonalTrigger = {
      id: roundId,
      sourceKind: "antigravity",
      sourceInstanceId: "agy-dispatcher",
      threadKey,
      senderId: "owner",
      addressedToAgent: true,
      fromAllowedSender: true,
      text,
      createdAt: nowIso,
      hopCount: hopMeta.hopCount,
      originTriggerId: hopMeta.originTriggerId,
    };
    const decision = evaluatePersonalTrigger(trigger, { maxHops: this.maxHops });
    this.opts.causalLedger?.append({
      roundId,
      kind: "round_triggered",
      at: nowIso,
      source: "antigravity",
      targetRef: threadKey,
      triggerId: roundId,
      hopCount: decision.hopCount ?? hopMeta.hopCount,
      maxHops: decision.maxHops ?? this.maxHops,
    });
    if (decision.outcome === "halt_circuit_breaker") {
      this.opts.causalLedger?.append({
        roundId,
        kind: "circuit_broken",
        at: nowIso,
        hopCount: decision.hopCount ?? hopMeta.hopCount,
        maxHops: decision.maxHops ?? this.maxHops,
        outcome: decision.outcome,
        reasonCode: decision.reasonCode,
        summary: decision.reasonText,
      });
      return {
        ok: false,
        roundId,
        hopCount: decision.hopCount ?? hopMeta.hopCount,
        maxHops: decision.maxHops ?? this.maxHops,
        errorCode: "HOP_CIRCUIT_BROKEN",
        message: decision.reasonText,
      };
    }
    return null;
  }

  async resumeSession(input: {
    conversationId: string;
    content: string;
    title?: string;
    hopCount?: number;
    parentTrigger?: PersonalTrigger;
  }): Promise<DispatchOutcome> {
    const roundId = `rnd-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    const blocked = this.checkHopGate(roundId, `antigravity:conv:${input.conversationId}`, input.content, input);
    if (blocked) return blocked;

    const meta = await this.runner.getConversationMetadata(input.conversationId);
    if (!meta.exists || meta.killed) {
      return { ok: false, roundId, hopCount: input.parentTrigger ? (input.parentTrigger.hopCount ?? 0) + 1 : (input.hopCount ?? 0), maxHops: this.maxHops, errorCode: "SESSION_UNAVAILABLE", message: "目标 Antigravity 会话不存在或已终止。" };
    }
    if ((meta.nestingDepth ?? 0) > 0 || Boolean(meta.parentConversationId?.trim())) {
      return { ok: false, roundId, hopCount: input.parentTrigger ? (input.parentTrigger.hopCount ?? 0) + 1 : (input.hopCount ?? 0), maxHops: this.maxHops, errorCode: "SUBAGENT_DISPATCH_FORBIDDEN", message: "禁止直接向子代理会话派发任务，仅允许唤醒根会话。" };
    }
    if (meta.workspaceUris?.length && meta.workspaceUris.some((u) => !this.isWorkspaceAllowed(u))) {
      return { ok: false, roundId, hopCount: input.parentTrigger ? (input.parentTrigger.hopCount ?? 0) + 1 : (input.hopCount ?? 0), maxHops: this.maxHops, errorCode: "WORKSPACE_NOT_ALLOWED", message: "目标会话工作目录不在允许的 sidecar / 工作区白名单内。" };
    }

    const hopCount = input.parentTrigger ? (input.parentTrigger.hopCount ?? 0) + 1 : (input.hopCount ?? 0);
    this.opts.causalLedger?.append({ roundId, kind: "worker_claimed", at: this.nowIsoFn(), workerId: input.conversationId, modelRole: "executor" });
    const sent = await this.runner.sendMessage({ recipientId: input.conversationId, content: input.content, ...(input.title ? { title: input.title } : {}) });
    if (!sent.ok) {
      return { ok: false, roundId, hopCount, maxHops: this.maxHops, conversationId: input.conversationId, errorCode: "AGENTAPI_FAILED", message: `agentapi send-message 退出码 ${sent.exitCode}` };
    }
    this.opts.causalLedger?.append({ roundId, kind: "round_completed", at: this.nowIsoFn(), outcome: "done", summary: `已唤醒会话 ${input.conversationId}` });
    return { ok: true, roundId, hopCount, maxHops: this.maxHops, conversationId: input.conversationId };
  }

  async startNewSession(input: {
    prompt: string;
    workspacePath?: string;
    model?: "flash_lite" | "flash" | "pro" | string;
    title?: string;
    profile?: string;
    hopCount?: number;
    parentTrigger?: PersonalTrigger;
  }): Promise<DispatchOutcome> {
    const roundId = `rnd-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    const hopCount = input.parentTrigger ? (input.parentTrigger.hopCount ?? 0) + 1 : (input.hopCount ?? 0);
    const blocked = this.checkHopGate(roundId, `antigravity:new:${input.workspacePath ?? "default"}`, input.prompt, input);
    if (blocked) return blocked;

    if (input.workspacePath && !this.isWorkspaceAllowed(input.workspacePath)) {
      return { ok: false, roundId, hopCount, maxHops: this.maxHops, errorCode: "WORKSPACE_NOT_ALLOWED", message: `目录 ${input.workspacePath} 不在允许的工作区白名单内。` };
    }
    this.opts.causalLedger?.append({ roundId, kind: "worker_claimed", at: this.nowIsoFn(), workerId: "agentapi-new", modelRole: "executor" });
    const resolvedWorkspace = input.workspacePath ? uriToFsPath(input.workspacePath) : undefined;
    const res = await this.runner.newConversation({
      prompt: input.prompt,
      model: input.model,
      title: input.title,
      profile: input.profile,
      ...(resolvedWorkspace ? { cwd: resolvedWorkspace } : {}),
    });
    if (res.exitCode !== 0) {
      return { ok: false, roundId, hopCount, maxHops: this.maxHops, errorCode: "AGENTAPI_FAILED", message: `agentapi new-conversation 退出码 ${res.exitCode}` };
    }
    this.opts.causalLedger?.append({ roundId, kind: "round_completed", at: this.nowIsoFn(), outcome: "done", summary: `已拉起新会话 ${res.conversationId ?? ""}`.trim() });
    return { ok: true, roundId, hopCount, maxHops: this.maxHops, ...(res.conversationId ? { conversationId: res.conversationId } : {}) };
  }
}
export interface CanonPublishDraft {
  canonId: string;
  title: string;
  slug: string;
  markdownBody: string;
  privacyTier: Exclude<PrivacySovereigntyTier, "local_only">;
  sourceRefs: string[];
  unifiedDiffPreview: string;
}

export interface PublicCanonPublisher {
  readonly publisherId: string;
  dryRunDiff(draft: CanonPublishDraft): Promise<{ diffText: string; redactionWarnings: string[]; confirmHash: string }>;
  publishCanon(draft: CanonPublishDraft, ownerConfirmedHash: string): Promise<{ publishedUrl: string; at: string }>;
  revokeCanon(slug: string, ownerConfirmedHash: string): Promise<void>;
}

export interface OpsProjectionSnapshot {
  snapshotId: string;
  generatedAt: string;
  privacyTier: Exclude<PrivacySovereigntyTier, "local_only">;
  projectCounts: { active: number; waitingReview: number; offlineVolumes: number };
  items: Array<{
    projectKey: string;
    status: "idle" | "running" | "waiting_review" | "volume_offline";
    updatedAt: string;
    sanitizedSummary?: string;
    tierEpoch?: number;
  }>;
}

export interface OpsProjectionSink {
  readonly sinkId: string;
  projectSnapshot(snapshot: OpsProjectionSnapshot): Promise<{ accepted: boolean; reason?: string }>;
  healthCheck(): Promise<{ reachable: boolean; coldStartMs?: number }>;
}

export class LocalDiffCanonPublisher implements PublicCanonPublisher {
  readonly publisherId = "local-diff-canon-publisher";
  readonly published = new Map<string, { draft: CanonPublishDraft; publishedAt: string }>();

  private hashFor(slug: string, body: string): string {
    return crypto.createHash("sha256").update(`${slug}\n${body}`).digest("hex").slice(0, 12);
  }

  async dryRunDiff(draft: CanonPublishDraft): Promise<{ diffText: string; redactionWarnings: string[]; confirmHash: string }> {
    const warnings: string[] = [];
    if (looksSecret(draft.markdownBody)) warnings.push("检测到疑似密钥或长数字串，外发前建议人工脱敏");
    if (/\/Users\/|\/home\/|C:\\Users\\/i.test(draft.markdownBody)) warnings.push("包含本机绝对路径，已建议剥离");
    const confirmHash = this.hashFor(draft.slug, draft.markdownBody);
    const diffText = [
      `--- a/${draft.slug}.md`,
      `+++ b/${draft.slug}.md`,
      `# ${draft.title} [confirmHash=${confirmHash}]`,
      ...draft.markdownBody.split("\n").slice(0, 20).map((l) => `+ ${l}`),
    ].join("\n");
    return { diffText, redactionWarnings: warnings, confirmHash };
  }

  async publishCanon(draft: CanonPublishDraft, ownerConfirmedHash: string): Promise<{ publishedUrl: string; at: string }> {
    if ((draft.privacyTier as string) === "local_only") {
      throw new Error("Refusing to publish local_only draft.");
    }
    const expected = this.hashFor(draft.slug, draft.markdownBody);
    if (ownerConfirmedHash.trim() !== expected) {
      throw new Error("Owner confirmation hash mismatch; publish rejected.");
    }
    const at = new Date().toISOString();
    this.published.set(draft.slug, { draft, publishedAt: at });
    return { publishedUrl: `canon://local/${draft.slug}`, at };
  }

  async revokeCanon(slug: string, ownerConfirmedHash: string): Promise<void> {
    if (!ownerConfirmedHash.trim()) throw new Error("Confirmation hash required to revoke canon.");
    this.published.delete(slug);
  }
}

export class PrivacyFilteredOpsProjectionSink implements OpsProjectionSink {
  readonly sinkId = "privacy-filtered-ops-sink";
  readonly acceptedSnapshots: OpsProjectionSnapshot[] = [];

  constructor(private readonly registry: ProjectPrivacyRegistry) {}

  async projectSnapshot(snapshot: OpsProjectionSnapshot): Promise<{ accepted: boolean; reason?: string }> {
    const filteredItems: OpsProjectionSnapshot["items"] = [];
    for (const item of snapshot.items) {
      const check = this.registry.sanitizeForProjectTier(
        { projectKey: item.projectKey, status: item.status, updatedAt: item.updatedAt, ...(item.sanitizedSummary ? { summary: item.sanitizedSummary } : {}) },
        item.projectKey,
        item.tierEpoch,
      );
      if (!check.allowed) continue;
      filteredItems.push({
        projectKey: item.projectKey,
        status: item.status,
        updatedAt: item.updatedAt,
        tierEpoch: check.tierEpoch,
        ...(check.tier === 2 && typeof check.sanitized.summary === "string" ? { sanitizedSummary: check.sanitized.summary } : {}),
      });
    }
    const cleanSnap: OpsProjectionSnapshot = { ...snapshot, items: filteredItems };
    this.acceptedSnapshots.push(cleanSnap);
    return { accepted: true };
  }

  async healthCheck(): Promise<{ reachable: boolean }> {
    return { reachable: true };
  }
}
