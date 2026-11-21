import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalDiffCanonPublisher,
  PrivacyFilteredOpsProjectionSink,
  ProjectPrivacyRegistry,
  StewardshipLedger,
  SugentStewardMcpServer,
  SuspendedRoundStore,
  stageSugentStewardPluginMcp,
} from "../src/sugent/index.js";

describe("Sprint 3: SugentStewardMcpServer & Plugin MCP Isolation", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  const makeTmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-s3-mcp-"));
    dirs.push(d);
    return d;
  };

  it("enforces privacy tiers, tierEpoch staleness, personal_life isolation, approval suspend, and canon diff hash", async () => {
    const tmp = makeTmp();
    const ledger = new StewardshipLedger({ dataDir: tmp });
    ledger.upsertGoal({ id: "g-work", partition: "work_project", title: "交付核心接口", northStarCriterion: "单测全过" });
    ledger.upsertResource({ id: "r-priv", partition: "personal_life", kind: "personal_archive", title: "私人户口本", localUriOrPath: "/tmp/secret-id.pdf", metadata: {} });

    const privacy = new ProjectPrivacyRegistry({ dataDir: tmp });
    const suspendedStore = new SuspendedRoundStore(tmp);
    const canonPublisher = new LocalDiffCanonPublisher();
    const opsSink = new PrivacyFilteredOpsProjectionSink(privacy);
    const notified: string[] = [];
    const mcp = new SugentStewardMcpServer({
      ledger,
      privacyRegistry: privacy,
      suspendedStore,
      canonPublisher,
      opsSink,
      notifyOwner: (m) => { notified.push(`${m.roundId}:${m.riskLevel}`); },
    });

    const t0 = privacy.setProjectTier("repo:org/secret", 0);
    const recall0 = await mcp.callTool("steward_recall_context", { projectKey: "repo:org/secret", query: "核心", incomingTierEpoch: t0.tierEpoch });
    expect(recall0.ok).toBe(false);
    expect(recall0.errorCode).toBe("tier_0_local_only");

    const t2 = privacy.setProjectTier("repo:org/app", 2);
    const t1 = privacy.setProjectTier("repo:org/app", 1);
    const staleRecall = await mcp.callTool("steward_recall_context", { projectKey: "repo:org/app", query: "核心", incomingTierEpoch: t2.tierEpoch });
    expect(staleRecall.ok).toBe(false);
    expect(staleRecall.errorCode).toBe("stale_tier_epoch");

    const okRecall = await mcp.callTool("steward_recall_context", { projectKey: "repo:org/app", query: "私人户口本", incomingTierEpoch: t1.tierEpoch });
    expect(okRecall.ok).toBe(true);
    expect(JSON.stringify(okRecall)).not.toContain("secret-id.pdf");
    expect((okRecall.goals as Array<{ title: string }>)[0]?.title).toBe("交付核心接口");
    const approve = await mcp.callTool("steward_request_owner_approval", { conversationId: "conv-m-1", actionSummary: "确认合入主干", riskLevel: "high", hopCount: 2 });
    expect(approve.suspended).toBe(true);
    expect(suspendedStore.listPending().length).toBe(1);
    expect(notified.length).toBe(1);

    const mile = await mcp.callTool("steward_report_milestone", { conversationId: "conv-m-1", projectKey: "repo:org/app", summary: "Sprint 3 达标" });
    expect(mile.ok).toBe(true);
    expect(mile.projected).toBe(true);
    expect(opsSink.acceptedSnapshots.length).toBe(1);

    const canonDry = await mcp.callTool("steward_propose_canon_diff", { projectKey: "repo:org/app", slug: "s3-doc", title: "发布说明", markdownBody: "已完成 MCP 集成" });
    expect(canonDry.requiresOwnerConfirm).toBe(true);
    const canonBad = await mcp.callTool("steward_propose_canon_diff", { projectKey: "repo:org/app", slug: "s3-doc", title: "发布说明", markdownBody: "已完成 MCP 集成", ownerConfirmedHash: "bad" });
    expect(canonBad.errorCode).toBe("confirm_hash_mismatch");
    const canonOk = await mcp.callTool("steward_propose_canon_diff", { projectKey: "repo:org/app", slug: "s3-doc", title: "发布说明", markdownBody: "已完成 MCP 集成", ownerConfirmedHash: canonDry.confirmHash });
    expect(canonOk.published).toBe(true);

    const initRpc = await mcp.handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect((initRpc.result as { serverInfo: { name: string } }).serverInfo.name).toBe("sugent-steward-mcp");
    const listRpc = await mcp.handleJsonRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(((listRpc.result as { tools: unknown[] }).tools).length).toBe(4);
    const callRpc = await mcp.handleJsonRpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "steward_recall_context", arguments: { projectKey: "repo:org/secret", query: "a" } } });
    expect((callRpc.result as { isError: boolean }).isError).toBe(true);

    expect(() => stageSugentStewardPluginMcp(path.join(os.homedir(), ".gemini", "config", "mcp_config.json"), { serverUrl: "http://127.0.0.1:3900/amb/api/steward/mcp" })).toThrow();
    const plugDir = path.join(tmp, "plugins");
    fs.mkdirSync(plugDir, { recursive: true });
    const staged = stageSugentStewardPluginMcp(plugDir, { serverUrl: "http://127.0.0.1:3900/amb/api/steward/mcp" });
    expect(fs.existsSync(staged.pluginJsonPath) && fs.existsSync(staged.mcpConfigPath)).toBe(true);
    const parsedMcp = JSON.parse(fs.readFileSync(staged.mcpConfigPath, "utf8")) as { mcpServers: Record<string, { serverUrl: string }> };
    expect(parsedMcp.mcpServers["sugent-steward"]?.serverUrl).toBe("http://127.0.0.1:3900/amb/api/steward/mcp");
  });
});
