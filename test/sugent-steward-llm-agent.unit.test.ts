import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConciergeChannelBridge,
  LocalBudgetLedger,
  SugentKnowledgeGraph,
  SugentStewardHostService,
} from "../src/sugent/index.js";

describe("StewardLlmAgent: Neon thought_signature preservation, deterministic guardrails & offline fallback", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  const setup = (llmFetch: typeof fetch, onUsage?: (usd: number) => void) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-llm-agent-"));
    dirs.push(tmp);
    const kg = new SugentKnowledgeGraph(path.join(tmp, "kg"));
    const budgets = new LocalBudgetLedger(tmp);
    const conciergeBridge = new ConciergeChannelBridge({
      dataDir: tmp,
      knowledgeGraph: kg,
      resolveActorRole: () => "external_peer",
      defaultTransport: { notifyOwner: async () => {}, sendPeerDirectMessage: async () => {} },
    });
    const svc = new SugentStewardHostService({
      dataDir: tmp,
      homeDir: tmp,
      knowledgeGraph: kg,
      localBudgets: budgets,
      conciergeBridge,
      llmFetch,
      recordUsageUsd: onUsage,
      getGatewayConfig: () => ({
        mode: "external",
        unlockSubscriptions: false,
        privacyMasking: false,
        baseUrl: "http://127.0.0.1:43199/v1",
        apiKey: "tok-unit-test",
        routing: { assessor: "gemini-4-neon-xhigh", executor: "gemini-4-neon-xhigh", computerUse: "gemini-4-neon-xhigh", steward: "gemini-4-neon-xhigh" },
      }),
    });
    return { svc, conciergeBridge };
  };
  it("preserves extra_content.google.thought_signature across multi-turn tool calls and enforces goal-cap / same-turn double-confirm", async () => {
    let callIdx = 0;
    let recordedUsd = 0;
    let sawSameTurnBlock = false;
    const mockFetch: typeof fetch = async (_url, init) => {
      callIdx += 1;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["User-Agent"]).toBe("Sugent/0.1");
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ role: string; content?: string; tool_calls?: Array<{ extra_content?: { google?: { thought_signature?: string } } }> }> };

      if (callIdx === 1) {
        return new Response(JSON.stringify({
          model: "gemini-4-neon",
          usage: { prompt_tokens: 100, completion_tokens: 40 },
          choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "manage_focus_goals", arguments: JSON.stringify({ action: "add", title: "第4个目标" }) }, extra_content: { google: { thought_signature: "sig-test-123" } } }] } }],
        }));
      }
      if (callIdx === 2) {
        const asstMsg = body.messages.find((m) => m.role === "assistant" && m.tool_calls?.length);
        if (asstMsg?.tool_calls?.[0]?.extra_content?.google?.thought_signature !== "sig-test-123") {
          return new Response("Missing thought_signature", { status: 400 });
        }
        const toolMsg = body.messages.findLast((m) => m.role === "tool");
        expect(JSON.parse(String(toolMsg?.content)).errorCode).toBe("GOAL_CAP_EXCEEDED");
        return new Response(JSON.stringify({ model: "gemini-4-neon", usage: { prompt_tokens: 120, completion_tokens: 30 }, choices: [{ message: { role: "assistant", content: "当前 3 个重点目标已满，你要替换哪一个？" } }] }));
      }
      if (callIdx === 3) {
        return new Response(JSON.stringify({ model: "gemini-4-neon", choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_2", type: "function", function: { name: "manage_messages", arguments: JSON.stringify({ action: "send_custom", peerQuery: "王总", customBody: "标准包 5 万元" }) }, extra_content: { google: { thought_signature: "sig-2" } } }] } }] }));
      }
      if (callIdx === 4) {
        return new Response(JSON.stringify({ model: "gemini-4-neon", choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_3", type: "function", function: { name: "manage_messages", arguments: JSON.stringify({ action: "confirm_pending" }) }, extra_content: { google: { thought_signature: "sig-3" } } }] } }] }));
      }
      if (callIdx === 5) {
        const lastTool = JSON.parse(String(body.messages.findLast((m) => m.role === "tool")?.content));
        sawSameTurnBlock = lastTool.errorCode === "SAME_TURN_CONFIRM_FORBIDDEN";
        return new Response(JSON.stringify({ model: "gemini-4-neon", choices: [{ message: { role: "assistant", content: "带 5 万元金额需先确认，是否发送给王总？" } }] }));
      }
      return new Response("down", { status: 503 });
    };

    const { svc, conciergeBridge } = setup(mockFetch, (u) => { recordedUsd += u; });
    svc.ledger.upsertGoal({ id: "g1", partition: "work_project", title: "目标一", northStarCriterion: "c1" });
    svc.ledger.upsertGoal({ id: "g2", partition: "work_project", title: "目标二", northStarCriterion: "c2" });
    svc.ledger.upsertGoal({ id: "g3", partition: "work_project", title: "目标三", northStarCriterion: "c3" });
    await conciergeBridge.processInboundEvent({ id: "w1", channel: "weixin", botId: "default", account: "default", conversation: { kind: "dm", id: "wx_w" }, sender: { id: "wx_w", name: "王总" }, parts: [{ type: "text", text: "怎么收费？" }], replyHandle: {}, receivedAt: Date.now() });

    const r1 = await svc.converse({ text: "把第4个目标加进去" });
    expect(r1.intent).toBe("llm_agent");
    expect(r1.reply).toContain("替换");
    expect(recordedUsd).toBeGreaterThan(0);

    const r2 = await svc.converse({ text: "给王总回标准包 5 万元" });
    expect(sawSameTurnBlock).toBe(true);
    expect(r2.reply).toContain("确认");

    const rFallback = await svc.converse({ text: "我的重点目标有哪些？" });
    expect(rFallback.intent).toBe("goals_query");
    expect(rFallback.reply).toContain("目标一");
  });

  it("separates runningNow vs Kanban active lanes vs folded idle_untracked in manage_ops_fleet so idle repos are never misreported as running", async () => {
    let capturedOverview: Record<string, unknown> | undefined;
    let callIdx = 0;
    const mockFetch: typeof fetch = async (_url, init) => {
      callIdx += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ role: string; content?: string }> };
      if (callIdx === 1) {
        return new Response(
          JSON.stringify({
            model: "gemini-4-neon",
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_ops_1",
                      type: "function",
                      function: { name: "manage_ops_fleet", arguments: JSON.stringify({ action: "overview" }) },
                    },
                  ],
                },
              },
            ],
          }),
        );
      }
      const toolMsg = body.messages.findLast((m) => m.role === "tool");
      capturedOverview = JSON.parse(String(toolMsg?.content ?? "{}")) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          model: "gemini-4-neon",
          choices: [{ message: { role: "assistant", content: "当前 1 个正在运行（sugent），1 个门禁观测中（airtoken），另有 2 个静默项目已折叠。" } }],
        }),
      );
    };

    const { svc } = setup(mockFetch);
    svc.ingestEdgeNodePulse({
      nodeId: "local-mac",
      projects: [
        {
          projectKey: "repo:ldc861117/sugent",
          displayName: "sugent",
          stage: "focus",
          boardStatus: "active_executing",
          status: "running",
          updatedAtIso: "2026-11-26T04:20:00Z",
          statusCard: { stageGoal: "统一云端大脑", reviewState: "pending_review" },
        },
        {
          projectKey: "local:local-mac:old-demo-1",
          displayName: "old-demo-1",
          stage: "archived",
          boardStatus: "idle_untracked",
          status: "idle",
          updatedAtIso: "2026-10-01T00:00:00Z",
        },
        {
          projectKey: "local:local-mac:old-demo-2",
          displayName: "old-demo-2",
          stage: "incubating",
          boardStatus: "idle_untracked",
          status: "idle",
          updatedAtIso: "2026-10-02T00:00:00Z",
        },
      ],
    });
    svc.setRemoteOpsSnapshot({
      projects: [
        {
          projectKey: "repo:ldc861117/airtoken",
          displayName: "airtoken",
          nodeId: "gce-airtoken",
          nodes: ["gce-airtoken"],
          stage: "focus",
          boardStatus: "monitoring",
          status: "idle",
          boardStatusReason: "H0 Canary 30 笔门禁观测中",
          statusCard: { stageGoal: "H0 Canary 跑满 30 笔实盘闭环", reviewState: "confirmed" },
        },
      ],
      pendingInbox: [],
    });

    const out = await svc.converse({ text: "现在你能看到在运行项目吗" });
    expect(out.ok).toBe(true);
    const counts = capturedOverview?.counts as Record<string, number> | undefined;
    expect(counts?.totalManaged).toBe(4);
    expect(counts?.runningNow).toBe(1);
    expect(counts?.monitoring).toBe(1);
    expect(counts?.idleUntracked).toBe(2);
    const runningNowProjects = capturedOverview?.runningNowProjects as Array<{ displayName: string }> | undefined;
    expect(runningNowProjects?.map((p) => p.displayName)).toEqual(["sugent"]);
    const activeBoard = capturedOverview?.projects as Array<{ displayName: string }> | undefined;
    expect(activeBoard?.map((p) => p.displayName)).toEqual(["sugent", "airtoken"]);
  });
});
