import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AirTokenOpsBridgeClient,
  LocalBudgetLedger,
  OwnerChannelStewardRouter,
  StewardLlmAgent,
  SugentKnowledgeGraph,
  SugentStewardHostService,
  buildAirTokenBridgeMethods,
  detectAirTokenSecretLeak,
  normalizeAirTokenUrls,
  parseAirTokenNaturalShortcut,
  type StewardWorkbenchLike,
} from "../src/sugent/index.js";

const mockGatewayUrl = ["http:", "", "127.0.0.1:8317", "v1"].join("/");

function makeService(opts: {
  airtokenEnv?: Record<string, string | undefined>;
  airtokenFetch?: typeof fetch;
  llmFetch?: typeof fetch;
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-at-"));
  const kg = new SugentKnowledgeGraph(dir);
  const budgets = new LocalBudgetLedger(dir);
  return new SugentStewardHostService({
    dataDir: dir,
    knowledgeGraph: kg,
    localBudgets: budgets,
    homeDir: dir,
    airtokenEnv: opts.airtokenEnv,
    airtokenFetch: opts.airtokenFetch,
    llmFetch: opts.llmFetch,
  });
}

describe("AirTokenOpsBridgeClient & Conversational Integration", () => {
  it("normalizes /dashboard URLs for API calls while preserving #unlock link", () => {
    const urls = normalizeAirTokenUrls(
      "https://airtoken.example.com/dashboard",
      "https://airtoken.example.com/dashboard",
    );
    expect(urls.apiOrigin).toBe("https://airtoken.example.com");
    expect(urls.publicDashboardUrl).toBe("https://airtoken.example.com/dashboard");
  });

  it("parses slash shortcuts and natural Chinese commands across all 8 ops", () => {
    expect(parseAirTokenNaturalShortcut("/at status")).toEqual({ kind: "command", command: "/status" });
    expect(parseAirTokenNaturalShortcut("/airtoken extend 12h")).toEqual({ kind: "command", command: "/extend 12h" });
    expect(parseAirTokenNaturalShortcut("把 airtoken 会话续 12 小时")).toEqual({ kind: "command", command: "/extend 12h" });
    expect(parseAirTokenNaturalShortcut("续期 airtoken")).toEqual({ kind: "command", command: "/extend 8h" });
    expect(parseAirTokenNaturalShortcut("看看 airtoken 战绩")).toEqual({ kind: "command", command: "/epoch" });
    expect(parseAirTokenNaturalShortcut("airtoken 切回纸盘")).toEqual({ kind: "command", command: "/mode paper" });
    expect(parseAirTokenNaturalShortcut("airtoken 恢复 canary")).toEqual({ kind: "command", command: "/mode canary" });
    expect(parseAirTokenNaturalShortcut("锁死 airtoken 金库")).toEqual({ kind: "command", command: "/lock" });
    expect(parseAirTokenNaturalShortcut("回收 airtoken 粉尘租金")).toEqual({ kind: "command", command: "/reclaim --burn-dust" });
    expect(parseAirTokenNaturalShortcut("airtoken 维护状态")).toEqual({ kind: "command", command: "/maintenance status" });
    expect(parseAirTokenNaturalShortcut("我要解锁 airtoken")).toEqual({ kind: "smart_unlock" });
  });

  it("handles smart unlock differently when UNLOCKED vs LOCKED", async () => {
    const seenCmds: string[] = [];
    let unlockedState = true;
    const mockFetch: typeof fetch = async (url, init) => {
      expect(String(url)).toBe("https://airtoken.example.com/api/ops/im-command");
      const body = JSON.parse(String(init?.body || "{}")) as { command: string };
      seenCmds.push(body.command);
      if (body.command === "/status") {
        return new Response(
          JSON.stringify({
            ok: true,
            command: "status",
            reply_markdown: unlockedState
              ? "📊 **AirToken 运行状态 (`READY`)**\n• **金库 / 会话**: `UNLOCKED` | IPC TTL 剩余 **`142.0m`**"
              : "📊 **AirToken 运行状态 (`BLOCKED`)**\n• **金库 / 会话**: `LOCKED` | IPC TTL 剩余 **`0.0m`**",
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          ok: true,
          command: "unlock",
          reply_markdown: "🔐 点击链接解锁：https://airtoken.example.com/dashboard?restore_mode=CANARY_SEMI_AUTO#unlock",
        }),
        { status: 200 },
      );
    };

    const client = new AirTokenOpsBridgeClient({
      env: { AIRTOKEN_OPS_URL: "https://airtoken.example.com/dashboard", AIRTOKEN_IM_COMMAND_TOKEN: "tok-secret" },
      fetchFn: mockFetch,
    });
    const methods = buildAirTokenBridgeMethods(client);

    const res1 = await methods.handleShortcut("我要解锁 airtoken");
    expect(res1.handled).toBe(true);
    expect(res1.reply).toContain("已处于 `UNLOCKED` 解锁状态");
    expect(res1.reply).toContain("142.0 分钟");
    expect(seenCmds).toEqual(["/status"]);

    unlockedState = false;
    const res2 = await methods.handleShortcut("我要解锁 airtoken");
    expect(res2.handled).toBe(true);
    expect(res2.reply).toContain("?restore_mode=CANARY_SEMI_AUTO#unlock");
    expect(seenCmds).toEqual(["/status", "/status", "/unlock"]);
  });

  it("blocks inline passwords/keys before LLM or peer history and isolates non-owner callers", async () => {
    let llmCalls = 0;
    const svc = makeService({
      airtokenEnv: { AIRTOKEN_OPS_URL: "https://airtoken.example.com", AIRTOKEN_IM_COMMAND_TOKEN: "tok-1" },
      airtokenFetch: async () => new Response(JSON.stringify({ ok: true, reply_markdown: "ok" }), { status: 200 }),
    });
    const router = new OwnerChannelStewardRouter({
      steward: {
        handleAirTokenShortcut: (t) => svc.handleAirTokenShortcut(t),
        async converse() {
          llmCalls += 1;
          return { ok: true, intent: "llm_agent", reply: "llm", workbench: svc.getWorkbench("owner_private") };
        },
      },
    });

    const leak1 = await router.tryHandleInbound({
      channel: "weixin",
      peerId: "owner-1",
      isGroup: false,
      isOwnerPeer: true,
      text: "解锁 airtoken 密码是 MySecretPass123!",
    });
    expect(leak1.handled).toBe(true);
    expect(leak1.reply).toContain("安全拦截");
    expect(leak1.reply).toContain("?restore_mode=CANARY_SEMI_AUTO#unlock");
    expect(llmCalls).toBe(0);

    const leak2 = detectAirTokenSecretLeak("帮我解锁金库 0x" + "ab".repeat(32));
    expect(leak2).toContain("安全拦截");

    // Non-owner and group chats must be ignored by OwnerChannelStewardRouter
    const grp = await router.tryHandleInbound({
      channel: "weixin",
      peerId: "grp-1",
      isGroup: true,
      isOwnerPeer: true,
      text: "续期 airtoken 8h",
    });
    expect(grp.handled).toBe(false);

    // LLM tool gate rejects non-owner_private domain
    const agent = new StewardLlmAgent({
      getEndpoint: () => ({ baseUrl: mockGatewayUrl, apiKey: "k", model: "m" }),
      toolsPort: {
        getWorkbench: () => ({
          callerDomain: "cowork_shared",
          quietHoursActive: false,
          ledger: { version: 1, updatedAt: "", relationships: [], goals: [], guardrails: [], commitments: [], resources: [] },
          cadence: { dateKey: "2026-11-27", state: { nonUrgentSentCount: 0, dailySoftQuota: 0, morningDigestQueue: [] } },
          antigravity: { surfacesScanned: [], totalSessions: 0, totalSubagentsFolded: 0, sessions: [], projects: [] },
        }) as StewardWorkbenchLike,
        queryLedger: () => ({ goals: [], commitments: [], guardrails: [], relationships: [], resources: [] }),
        findArchiveResources: () => [],
        upsertArchiveResource: () => [],
        mutateCommitment: () => { throw new Error("unused"); },
        mutateGoal: () => { throw new Error("unused"); },
        mutateTrust: () => { throw new Error("unused"); },
        submitDropzone: async () => { throw new Error("unused"); },
        scanCadence: () => { throw new Error("unused"); },
        setQuietHours: () => { throw new Error("unused"); },
        setProjectTier: () => { throw new Error("unused"); },
        markSessionViewed: () => { throw new Error("unused"); },
        comprehendSession: async () => { throw new Error("unused"); },
        dispatchAntigravity: async () => { throw new Error("unused"); },
        manageAirTokenOps: (i) => svc.executeAirTokenOpsToolAction(i),
      },
    });
    const blocked = await (agent as unknown as {
      executeManageAirTokenOpsTool(a: Record<string, unknown>, d: string): Promise<Record<string, unknown>>;
    }).executeManageAirTokenOpsTool({ action: "extend", preset: "8h" }, "cowork_shared");
    expect(blocked.ok).toBe(false);
    expect(blocked.errorCode).toBe("OWNER_ONLY_TOOL");
  });
});
