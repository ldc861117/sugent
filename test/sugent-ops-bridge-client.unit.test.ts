import { describe, expect, it } from "vitest";
import {
  OpsBridgeClient,
  pruneProjectPulseForTier,
  resolveOpsBridgeConfig,
  type OpsProjectPulseInput,
} from "../src/sugent/ops-bridge-client.js";

const MOCK_OPS_BASE = ["https:", "", "ops.sugent.internal"].join("/");

describe("OpsBridgeClient (/api/ops/node/auth & /api/ops/bridge/*)", () => {
  it("stays 100% silent with zero network calls when OPS_BASE_URL is unconfigured (mode: none sovereignty)", async () => {
    let fetchCalls = 0;
    const cfg = resolveOpsBridgeConfig({});
    expect(cfg.enabled).toBe(false);
    const fallbackCfg = resolveOpsBridgeConfig({
      SUGENT_STEWARD_HUB_NODE: "   ",
      SUGENT_WEIXIN_OWNER_NODE: "custom-wx-hub",
    });
    expect(fallbackCfg.stewardHubNodeId).toBe("custom-wx-hub");

    const client = new OpsBridgeClient({
      ...cfg,
      fetchImpl: (async () => {
        fetchCalls += 1;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });

    const p = await client.pushPulse([]);
    const c = await client.pullCommands();
    expect(p.ok).toBe(false);
    expect(p.skipped).toBe(true);
    expect(c.ok).toBe(false);
    expect(fetchCalls).toBe(0);
  });

  it("caches 1h JWT, renews 5 minutes before expiry, and automatically re-authenticates once on 401", async () => {
    let nowMs = 1_700_000_000_000;
    let authCalls = 0;
    let forceFirst401 = false;
    const seenAuthHeaders: string[] = [];

    const client = new OpsBridgeClient({
      baseUrl: `${MOCK_OPS_BASE}/`,
      nodeToken: "node-secret-local",
      nodeId: "local-mac",
      nowMs: () => nowMs,
      fetchImpl: (async (input, init) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        if (url.endsWith("/api/ops/node/auth")) {
          authCalls += 1;
          return new Response(
            JSON.stringify({
              ok: true,
              token: `jwt-tok-${authCalls}`,
              expiresInSec: 3600,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        seenAuthHeaders.push(headers.get("authorization") ?? "");
        if (forceFirst401) {
          forceFirst401 = false;
          return new Response(JSON.stringify({ error: "expired_jwt" }), { status: 401 });
        }
        return new Response(JSON.stringify({ ok: true, commands: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });

    await client.pullCommands();
    await client.pullCommands();
    expect(authCalls).toBe(1);
    expect(seenAuthHeaders).toEqual(["Bearer jwt-tok-1", "Bearer jwt-tok-1"]);

    // Advance 55m + 1s (inside 5-minute pre-expiry window) -> proactively renews JWT
    nowMs += 55 * 60_000 + 1_000;
    await client.pullCommands();
    expect(authCalls).toBe(2);
    expect(seenAuthHeaders.at(-1)).toBe("Bearer jwt-tok-2");

    // Simulate server revoking JWT early -> 401 triggers 1 re-auth and transparent retry
    forceFirst401 = true;
    const resAfter401 = await client.pullCommands();
    expect(resAfter401.ok).toBe(true);
    expect(authCalls).toBe(3);
    expect(seenAuthHeaders.at(-1)).toBe("Bearer jwt-tok-3");
  });

  it("enforces strict Tier 0/1/2 field pruning on pushPulse and Tier-2-only filtering on pushSync", async () => {
    const capturedBodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    const client = new OpsBridgeClient({
      baseUrl: MOCK_OPS_BASE,
      nodeToken: "node-secret-local",
      nodeId: "local-mac",
      fetchImpl: (async (input, init) => {
        const url = String(input);
        if (url.endsWith("/api/ops/node/auth")) {
          return new Response(JSON.stringify({ token: "jwt-1", expiresInSec: 3600 }), { status: 200 });
        }
        capturedBodies.push({
          url,
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch,
    });

    const rawProjects: OpsProjectPulseInput[] = [
      {
        projectKey: "repo:owner/secret-fin",
        displayName: "Secret Finance Bot",
        tier: 0,
        updatedAtIso: "2026-11-24T12:00:00.000Z",
        sessionCount: 3,
        runningSessionCount: 1,
        subagentCount: 2,
        workspaceRoot: "/Users/alice/private/secret-fin",
        summary: " confidential payroll numbers ",
        runningSessions: [{ conversationId: "c1", title: "Payroll", stepCount: 9, activeSubagentCount: 1 }],
      },
      {
        projectKey: "repo:owner/airtoken",
        displayName: "AirToken Core",
        tier: 1,
        updatedAtIso: "2026-11-24T12:05:00.000Z",
        sessionCount: 5,
        runningSessionCount: 2,
        subagentCount: 4,
        workspaceRoot: "/Users/alice/work/airtoken",
        summary: "目录（/Users/alice/work/airtoken）：构建失败，缺少配置",
        runningSessions: [{ conversationId: "c2", title: "Milestone B", stepCount: 12, activeSubagentCount: 2 }],
      },
      {
        projectKey: "repo:ldc861117/sugent",
        displayName: "Sugent (/Volumes/SSD/sugent)",
        tier: 2,
        updatedAtIso: "2026-11-24T12:10:00.000Z",
        sessionCount: 4,
        runningSessionCount: 1,
        subagentCount: 0,
        workspaceRoot: "/Users/alice/Projects/sugent",
        summary: "Wave P0 closed, wiring GCE bridge",
        aliases: ["sugent", "/var/folders/xx/tmp/sugent", "D:\\Projects\\sugent"],
        runningSessions: [{ conversationId: "c3", title: "GCE Bridge", stepCount: 6, activeSubagentCount: 0 }],
      },
    ];

    const t0 = pruneProjectPulseForTier(rawProjects[0]!) as unknown as Record<string, unknown>;
    expect(t0.displayName).toBeUndefined();
    expect(t0.summary).toBeUndefined();
    expect(t0.workspaceRoot).toBeUndefined();
    expect(t0.runningSessions).toBeUndefined();
    expect(t0.codeName).toMatch(/^proj-[a-f0-9]{8}$/);

    await client.pushPulse(rawProjects);
    const pulsePayload = capturedBodies[0]!.body;
    const sentProjects = pulsePayload.projects as Array<Record<string, unknown>>;
    expect(sentProjects).toHaveLength(3);
    expect(JSON.stringify(sentProjects[0])).not.toContain("Secret Finance");
    expect(JSON.stringify(sentProjects[0])).not.toContain("payroll");
    expect(sentProjects[1]!.sanitizedSummary).toBe("目录（[local-path]）：构建失败，缺少配置");
    expect(sentProjects[1]!.runningSessions).toBeUndefined();
    expect(sentProjects[2]!.displayName).toBe("Sugent ([local-path])");
    expect(JSON.stringify(sentProjects[2]!.aliases)).not.toContain("/var/folders");
    expect(JSON.stringify(sentProjects[2]!.aliases)).not.toContain("D:\\Projects");
    expect(Array.isArray(sentProjects[2]!.runningSessions)).toBe(true);
    expect(sentProjects[2]!.workspaceRoot).toBeUndefined();

    await client.pushSync([
      { projectKey: "repo:owner/secret-fin", tier: 0, docKind: "roadmap", title: "Secret", summary: "No!" },
      { projectKey: "repo:owner/airtoken", tier: 1, docKind: "roadmap", title: "Tier1", summary: "Skip!" },
      { projectKey: "repo:ldc861117/sugent", tier: 2, docKind: "roadmap", title: "Roadmap v2.0", summary: "Wave P0 done" },
    ]);
    const syncDocs = capturedBodies[1]!.body.docs as Array<Record<string, unknown>>;
    expect(syncDocs).toHaveLength(1);
    expect(syncDocs[0]!.projectKey).toBe("repo:ldc861117/sugent");
  });

  it("handles idempotent command ack and restricts stewardPending / stewardSync to gce-hub node", async () => {
    let ackNetworkCalls = 0;
    const localClient = new OpsBridgeClient({
      baseUrl: MOCK_OPS_BASE,
      nodeToken: "tok-local",
      nodeId: "local-mac",
      stewardHubNodeId: "gce-hub",
      fetchImpl: (async (input) => {
        const url = String(input);
        if (url.endsWith("/api/ops/node/auth")) {
          return new Response(JSON.stringify({ token: "jwt-loc", expiresInSec: 3600 }), { status: 200 });
        }
        if (url.includes("/bridge/commands/") && url.endsWith("/ack")) {
          ackNetworkCalls += 1;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch,
    });

    const a1 = await localClient.ackCommand("cmd-101", { status: "completed", summary: "Done" });
    const a2 = await localClient.ackCommand("cmd-101", { status: "completed", summary: "Done" });
    expect(a1.ok).toBe(true);
    expect(a2.ok).toBe(true);
    expect(a2.idempotent).toBe(true);
    expect(ackNetworkCalls).toBe(1);

    // Non-hub node cannot call stewardPending or stewardSync
    const deniedPending = await localClient.stewardPending();
    expect(deniedPending.ok).toBe(false);
    expect(deniedPending.reason).toBe("NOT_STEWARD_HUB_NODE");

    const hubClient = new OpsBridgeClient({
      baseUrl: MOCK_OPS_BASE,
      nodeToken: "tok-hub",
      nodeId: "gce-hub",
      stewardHubNodeId: "gce-hub",
      fetchImpl: (async (input) => {
        const url = String(input);
        if (url.endsWith("/api/ops/node/auth")) {
          return new Response(JSON.stringify({ token: "jwt-hub", expiresInSec: 3600 }), { status: 200 });
        }
        if (url.endsWith("/api/ops/bridge/steward-pending")) {
          return new Response(
            JSON.stringify({
              ok: true,
              projects: [{ projectKey: "repo:owner/airtoken", displayName: "AirToken", status: "Stage B active" }],
              pendingInbox: [{ id: "inb-1", title: "Approve next week plan", targetNodeId: "local-mac" }],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ ok: true, synced: true }), { status: 200 });
      }) as typeof fetch,
    });

    const hubPending = await hubClient.stewardPending();
    expect(hubPending.ok).toBe(true);
    expect(hubPending.snapshot?.projects).toHaveLength(1);
    const hubSync = await hubClient.stewardSync({ weeklyFocus: ["Close GCE Resident Hub"] });
    expect(hubSync.ok).toBe(true);
  });
});
