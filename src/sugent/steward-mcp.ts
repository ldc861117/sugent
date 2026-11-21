import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalizeProjectKey,
  type ProjectPrivacyRegistry,
} from "./antigravity-bridge.js";
import type {
  CanonPublishDraft,
  OpsProjectionSink,
  PublicCanonPublisher,
} from "./antigravity-dispatcher.js";
import type { SuspendedRoundStore } from "./receipt-protocol.js";
import type { StewardshipLedger } from "./stewardship-ledger.js";
import type { PersonalTrigger } from "./types.js";

export interface SugentStewardMcpOptions {
  ledger: StewardshipLedger;
  privacyRegistry: ProjectPrivacyRegistry;
  suspendedStore?: SuspendedRoundStore;
  canonPublisher?: PublicCanonPublisher;
  opsSink?: OpsProjectionSink;
  notifyOwner?: (msg: { roundId: string; conversationId: string; summary: string; riskLevel: "low" | "medium" | "high" }) => Promise<void> | void;
  nowIso?: () => string;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOL_DEFS: readonly McpToolDefinition[] = [
  {
    name: "steward_recall_context",
    description: "Query work_project goals, guardrails, tombstones, and commitments subject to ProjectPrivacyRegistry.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceUri: { type: "string" },
        projectKey: { type: "string" },
        query: { type: "string" },
        incomingTierEpoch: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "steward_request_owner_approval",
    description: "Suspend execution zero-cost and request owner approval via mobile/desktop card.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string" },
        actionSummary: { type: "string" },
        riskLevel: { type: "string", enum: ["low", "medium", "high"] },
        hopCount: { type: "number" },
      },
      required: ["conversationId", "actionSummary", "riskLevel"],
    },
  },
  {
    name: "steward_report_milestone",
    description: "Report completed milestone to work_project ledger and sanitize-project to OpsProjectionSink.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string" },
        projectKey: { type: "string" },
        summary: { type: "string" },
        artifactPaths: { type: "array", items: { type: "string" } },
      },
      required: ["conversationId", "summary"],
    },
  },
  {
    name: "steward_propose_canon_diff",
    description: "Render local diff preview and require owner confirmation hash before publishing canon.",
    inputSchema: {
      type: "object",
      properties: {
        projectKey: { type: "string" },
        slug: { type: "string" },
        title: { type: "string" },
        markdownBody: { type: "string" },
        ownerConfirmedHash: { type: "string" },
      },
      required: ["projectKey", "slug", "title", "markdownBody"],
    },
  },
];
export class SugentStewardMcpServer {
  private readonly nowIsoFn: () => string;

  constructor(private readonly opts: SugentStewardMcpOptions) {
    this.nowIsoFn = opts.nowIso ?? (() => new Date().toISOString());
  }

  listTools(): readonly McpToolDefinition[] {
    return TOOL_DEFS;
  }

  private resolveKey(workspaceUri?: string, explicitKey?: string): string {
    if (explicitKey?.trim()) return explicitKey.trim();
    const raw = String(workspaceUri ?? "").trim();
    if (!raw) return "local:default:workspace";
    const folderPath = raw.startsWith("file://") ? (() => { try { return fileURLToPath(raw); } catch { return raw.slice(7); } })() : raw;
    let remoteUrl: string | undefined;
    try {
      const gitCfg = path.join(folderPath, ".git", "config");
      if (fs.existsSync(gitCfg)) {
        const m = /^\s*url\s*=\s*(.+?)\s*$/m.exec(fs.readFileSync(gitCfg, "utf8"));
        if (m?.[1]) remoteUrl = m[1];
      }
    } catch {
      // ignore git config read error
    }
    return canonicalizeProjectKey({ folderPath, remoteUrl });
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const nowIso = this.nowIsoFn();
    if (name === "steward_recall_context") {
      const workspaceUri = typeof args.workspaceUri === "string" ? args.workspaceUri : undefined;
      const projectKey = this.resolveKey(workspaceUri, typeof args.projectKey === "string" ? args.projectKey : undefined);
      const query = String(args.query ?? "");
      const incomingEpoch = typeof args.incomingTierEpoch === "number" ? args.incomingTierEpoch : undefined;
      const folderPath = workspaceUri?.startsWith("file://") ? workspaceUri.slice(7) : workspaceUri;
      const policy = this.opts.privacyRegistry.resolveProjectPolicy({ projectKey, ...(folderPath ? { workspaceRoot: folderPath } : {}) });
      const check = this.opts.privacyRegistry.sanitizeForProjectTier({ projectKey, query }, projectKey, incomingEpoch ?? policy.tierEpoch);
      if (!check.allowed) {
        return { ok: false, errorCode: check.staleEpoch ? "stale_tier_epoch" : check.reason ?? "tier_0_local_only", projectKey, tier: policy.tier, tierEpoch: policy.tierEpoch };
      }
      const ctx = this.opts.ledger.queryContext(query, "work_project");
      const snap = this.opts.ledger.snapshotForCaller("work_project");
      return {
        ok: true,
        projectKey,
        tier: policy.tier,
        tierEpoch: policy.tierEpoch,
        goals: snap.goals.filter((g) => g.status === "active"),
        guardrails: snap.guardrails,
        commitments: ctx.commitments,
      };
    }

    if (name === "steward_request_owner_approval") {
      const conversationId = String(args.conversationId ?? "").trim() || "unknown";
      const actionSummary = String(args.actionSummary ?? "").trim() || "需要主人拍板";
      const rawRisk = args.riskLevel;
      const riskLevel = rawRisk === "high" || rawRisk === "low" ? rawRisk : "medium";
      const roundId = `rnd-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
      const approvalId = `apr-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`;
      if (this.opts.suspendedStore) {
        const trigger: PersonalTrigger = {
          id: `trg-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`,
          sourceKind: "antigravity",
          sourceInstanceId: "steward-mcp",
          threadKey: `antigravity:mcp:${conversationId}`,
          senderId: "agent",
          addressedToAgent: true,
          fromAllowedSender: true,
          text: actionSummary,
          createdAt: nowIso,
          hopCount: typeof args.hopCount === "number" ? args.hopCount : 0,
        };
        this.opts.suspendedStore.suspend({ roundId, sessionId: conversationId, parentTrigger: trigger, approval: { approvalId, prompt: actionSummary, riskLevel }, suspendedAt: nowIso });
      }
      await this.opts.notifyOwner?.({ roundId, conversationId, summary: actionSummary, riskLevel });
      return { ok: true, suspended: true, roundId, approvalId, riskLevel };
    }
    if (name === "steward_report_milestone") {
      const conversationId = String(args.conversationId ?? "").trim() || "unknown";
      const projectKey = this.resolveKey(undefined, typeof args.projectKey === "string" ? args.projectKey : undefined);
      const summary = String(args.summary ?? "").trim() || "里程碑更新";
      const commit = this.opts.ledger.upsertCommitment(
        { partition: "work_project", direction: "i_owe", status: "waiting_review", summary, counterpartyOrRef: conversationId },
        nowIso,
      );
      const policy = this.opts.privacyRegistry.resolveProjectPolicy({ projectKey });
      let projected = false;
      if (this.opts.opsSink && policy.tier > 0) {
        await this.opts.opsSink.projectSnapshot({
          snapshotId: `ops-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`,
          generatedAt: nowIso,
          privacyTier: policy.tier === 2 ? "summary_allowed" : "metadata_only",
          projectCounts: { active: 1, waitingReview: 1, offlineVolumes: 0 },
          items: [{
            projectKey,
            status: "waiting_review",
            updatedAt: nowIso,
            tierEpoch: policy.tierEpoch,
            ...(policy.tier === 2 ? { sanitizedSummary: summary.slice(0, 200) } : {}),
          }],
        });
        projected = true;
      }
      return { ok: true, commitmentId: commit.id, projectKey, projected, tier: policy.tier, tierEpoch: policy.tierEpoch };
    }

    if (name === "steward_propose_canon_diff") {
      const projectKey = String(args.projectKey ?? "").trim();
      const policy = this.opts.privacyRegistry.resolveProjectPolicy({ projectKey });
      if (policy.tier === 0) {
        return { ok: false, errorCode: "tier_0_local_only", projectKey, tier: policy.tier, tierEpoch: policy.tierEpoch };
      }
      if (!this.opts.canonPublisher) {
        return { ok: false, errorCode: "publisher_not_configured" };
      }
      const draft: CanonPublishDraft = {
        canonId: `can-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`,
        slug: String(args.slug ?? "draft"),
        title: String(args.title ?? "未命名发布"),
        markdownBody: String(args.markdownBody ?? ""),
        privacyTier: policy.tier === 2 ? "summary_allowed" : "metadata_only",
        sourceRefs: [projectKey],
        unifiedDiffPreview: "",
      };
      const dry = await this.opts.canonPublisher.dryRunDiff(draft);
      const ownerHash = typeof args.ownerConfirmedHash === "string" ? args.ownerConfirmedHash.trim() : "";
      if (!ownerHash) {
        return { ok: true, published: false, requiresOwnerConfirm: true, confirmHash: dry.confirmHash, diffText: dry.diffText, redactionWarnings: dry.redactionWarnings };
      }
      if (ownerHash !== dry.confirmHash) {
        return { ok: false, published: false, errorCode: "confirm_hash_mismatch", confirmHash: dry.confirmHash, diffText: dry.diffText };
      }
      const res = await this.opts.canonPublisher.publishCanon(draft, ownerHash);
      return { ok: true, published: true, ...res, confirmHash: dry.confirmHash, diffText: dry.diffText };
    }
    return { ok: false, errorCode: "unknown_tool", tool: name };
  }

  async handleJsonRpc(req: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> }): Promise<Record<string, unknown>> {
    const id = req.id ?? null;
    if (req.method === "initialize") {
      return { jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", serverInfo: { name: "sugent-steward-mcp", version: "0.1.0" }, capabilities: { tools: {} } } };
    }
    if (req.method === "notifications/initialized") {
      return { jsonrpc: "2.0", id, result: {} };
    }
    if (req.method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: this.listTools() } };
    }
    if (req.method === "tools/call") {
      const params = req.params ?? {};
      const out = await this.callTool(String(params.name ?? ""), (params.arguments as Record<string, unknown>) ?? {});
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify(out) }], isError: out.ok === false, structuredContent: out },
      };
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${String(req.method ?? "")}` } };
  }
}
export interface StagedPluginMcpResult {
  pluginDir: string;
  pluginJsonPath: string;
  mcpConfigPath: string;
}

function expandHome(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

export function stageSugentStewardPluginMcp(
  pluginsRootDir: string,
  serverConfig: { command?: string; args?: string[]; serverUrl?: string; env?: Record<string, string> },
  options: { pluginName?: string; serverKey?: string } = {},
): StagedPluginMcpResult {
  const expanded = expandHome(pluginsRootDir);
  if (!expanded) throw new Error("pluginsRootDir cannot be empty.");
  const resolvedRoot = path.resolve(expanded);
  const globalConfigDir = path.resolve(os.homedir(), ".gemini", "config");
  const globalMcpPath = path.join(globalConfigDir, "mcp_config.json");

  if (
    resolvedRoot === globalMcpPath ||
    resolvedRoot === globalConfigDir ||
    path.basename(resolvedRoot) === "mcp_config.json" ||
    expanded.replace(/\\/g, "/").endsWith("/.gemini/config/mcp_config.json")
  ) {
    throw new Error("Refusing to write to global ~/.gemini/config/mcp_config.json; use an isolated plugin directory.");
  }

  const pluginName = options.pluginName?.trim() || "sugent-steward";
  const serverKey = options.serverKey?.trim() || "sugent-steward";
  const pluginDir = path.join(resolvedRoot, pluginName);
  const pluginJsonPath = path.join(pluginDir, "plugin.json");
  const mcpConfigPath = path.join(pluginDir, "mcp_config.json");

  for (const checkPath of [resolvedRoot, pluginDir, pluginJsonPath, mcpConfigPath]) {
    if (fs.existsSync(checkPath) && fs.lstatSync(checkPath).isSymbolicLink()) {
      throw new Error(`Refusing to overwrite symbolic link at ${checkPath}`);
    }
  }

  fs.mkdirSync(pluginDir, { recursive: true, mode: 0o755 });
  if (!fs.existsSync(pluginJsonPath)) {
    fs.writeFileSync(
      pluginJsonPath,
      `${JSON.stringify({ name: pluginName, description: "Sugent personal steward lifecycle hooks and isolated MCP server" }, null, 2)}\n`,
      "utf8",
    );
  }
  const existing = fs.existsSync(mcpConfigPath)
    ? (JSON.parse(fs.readFileSync(mcpConfigPath, "utf8")) as { mcpServers?: Record<string, unknown> })
    : {};
  const nextMcp = {
    mcpServers: {
      ...(existing.mcpServers ?? {}),
      [serverKey]: serverConfig,
    },
  };
  fs.writeFileSync(mcpConfigPath, `${JSON.stringify(nextMcp, null, 2)}\n`, "utf8");
  return { pluginDir, pluginJsonPath, mcpConfigPath };
}
