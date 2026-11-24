import { describe, expect, it } from "vitest";
import { StewardLlmAgent } from "../src/sugent/steward-llm-agent.js";
import type { StewardWorkbenchLike } from "../src/sugent/steward-conversation.js";
import { OwnerChannelStewardRouter } from "../src/sugent/owner-channel-steward-router.js";

const stubWb = (): StewardWorkbenchLike => ({
  callerDomain: "owner_private",
  quietHoursActive: false,
  ledger: { version: 1, updatedAt: "", relationships: [], goals: [], guardrails: [], commitments: [], resources: [] },
  cadence: { dateKey: "2026-11-23", state: { nonUrgentSentCount: 0, dailySoftQuota: 0, morningDigestQueue: [] } },
  antigravity: { surfacesScanned: [], totalSessions: 0, totalSubagentsFolded: 0, sessions: [], projects: [] },
});

const mockGatewayUrl = ["http:", "", "127.0.0.1:8317", "v1"].join("/");

describe("OwnerChannelStewardRouter & StewardLlmAgent Local Task Delegation", () => {
  it("routes authenticated owner WeChat/Feishu DMs to unified Steward brain with bounded 10-turn sliding history", async () => {
    const seenCalls: Array<{ text: string; historyLen: number; channel?: string; callerDomain?: string }> = [];
    const router = new OwnerChannelStewardRouter({
      steward: {
        async converse(input) {
          seenCalls.push({
            text: input.text,
            historyLen: input.history?.length ?? 0,
            channel: input.channel,
            callerDomain: input.callerDomain,
          });
          return {
            ok: true,
            intent: "llm_agent",
            reply: `幕僚回复:${input.text}`,
            modelUsed: "claude-sonnet-4-6",
            workbench: stubWb(),
          };
        },
      },
    });

    for (let i = 1; i <= 12; i++) {
      const out = await router.tryHandleInbound({
        channel: "weixin",
        peerId: "wx-owner-1",
        isGroup: false,
        isOwnerPeer: true,
        text: `第${i}轮消息`,
      });
      expect(out.handled).toBe(true);
      expect(out.reply).toBe(`幕僚回复:第${i}轮消息`);
    }

    expect(seenCalls[0]?.historyLen).toBe(0);
    expect(seenCalls[1]?.historyLen).toBe(2);
    expect(seenCalls[11]?.historyLen).toBe(20);
    expect(seenCalls[11]?.channel).toBe("weixin");
    expect(seenCalls[11]?.callerDomain).toBe("owner_private");
  });

  it("strictly isolates external peers, group chats, disabled flag, and fallback endpoint absence", async () => {
    let called = false;
    const router = new OwnerChannelStewardRouter({
      steward: {
        async converse() {
          called = true;
          return { ok: false, intent: "unknown", reply: "", workbench: stubWb() };
        },
      },
    });

    expect(
      (await router.tryHandleInbound({ channel: "weixin", peerId: "stranger", isGroup: false, isOwnerPeer: false, text: "查合同底价" })).handled,
    ).toBe(false);
    expect(
      (await router.tryHandleInbound({ channel: "feishu", peerId: "chat-grp", isGroup: true, isOwnerPeer: true, text: "查主目标" })).handled,
    ).toBe(false);
    expect(called).toBe(false);

    const fallbackOut = await router.tryHandleInbound({
      channel: "feishu",
      peerId: "fs-owner",
      isGroup: false,
      isOwnerPeer: true,
      text: "你好",
    });
    expect(fallbackOut.handled).toBe(false);
  });

  it("intercepts retry-stronger voice/text shortcuts from owner DMs", async () => {
    let retriedDomain = "";
    const router = new OwnerChannelStewardRouter({
      steward: {
        async converse() {
          throw new Error("should not hit normal converse");
        },
        async retryLastTurnStronger(domain) {
          retriedDomain = domain ?? "";
          return {
            ok: true,
            intent: "llm_agent",
            reply: "已切换旗舰推理模型重答。",
            modelUsed: "gemini-4-hydrogen-xhigh",
            workbench: stubWb(),
          };
        },
      },
    });

    const out = await router.tryHandleInbound({
      channel: "weixin",
      peerId: "wx-owner-1",
      isGroup: false,
      isOwnerPeer: true,
      text: "换更强模型重试",
    });
    expect(out.handled).toBe(true);
    expect(retriedDomain).toBe("owner_private");
    expect(out.reply).toContain("旗舰推理模型");
  });

  it("executes delegate_local_execution tool in StewardLlmAgent to offload shell/file/GUI tasks", async () => {
    const delegated: Array<{ title: string; instruction: string; requireDesktopGui?: boolean }> = [];
    let round = 0;
    const agent = new StewardLlmAgent({
      getEndpoint: () => ({ baseUrl: mockGatewayUrl, apiKey: "mock-token", model: "claude-sonnet-4-6" }),
      fetchImpl: async () => {
        round += 1;
        if (round === 1) {
          return new Response(
            JSON.stringify({
              model: "claude-sonnet-4-6",
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "tc-del-1",
                        type: "function",
                        function: {
                          name: "delegate_local_execution",
                          arguments: JSON.stringify({
                            title: "导出 ERP 异常报表",
                            instruction: "打开本地 ERP 导出近 7 天异常单 CSV",
                            requireDesktopGui: true,
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            model: "claude-sonnet-4-6",
            choices: [{ message: { role: "assistant", content: "已在后台拉起本地执行任务 #tsk-101。" } }],
          }),
          { status: 200 },
        );
      },
      toolsPort: {
        getWorkbench: stubWb,
        queryLedger: () => ({ goals: [], commitments: [], guardrails: [], relationships: [], ledgerSummary: "" }),
        findArchiveResources: () => [],
        upsertArchiveResource: () => [],
        mutateCommitment: () => ({ ok: true, commitment: {} as never, workbench: stubWb() }),
        mutateGoal: () => ({ ok: true, workbench: stubWb() }),
        mutateTrust: () => ({ ok: true, workbench: stubWb() }),
        submitDropzone: async () => ({ ok: true, outcome: {} as never, workbench: stubWb() }),
        scanCadence: () => ({ emitNow: [], foldToMorningDigest: [], workbench: stubWb() }),
        setQuietHours: () => ({ quietHoursActive: false, workbench: stubWb() }),
        setProjectTier: () => ({ workbench: stubWb() }),
        markSessionViewed: () => ({ workbench: stubWb() }),
        comprehendSession: async () => ({} as never),
        dispatchAntigravity: async () => ({} as never),
        delegateLocalTask: async (input: { title: string; instruction: string; requireDesktopGui?: boolean }) => {
          delegated.push(input);
          return { ok: true, taskId: "tsk-101", status: "queued" };
        },
      } as never,
    });

    const out = await agent.runTurn({ text: "帮我打开 ERP 导出本周异常单", channel: "weixin" });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.toolCallsExecuted).toContain("delegate_local_execution");
      expect(out.reply).toContain("tsk-101");
    }
    expect(delegated).toHaveLength(1);
    expect(delegated[0]?.requireDesktopGui).toBe(true);
  });

  it("prevents orphaned leading assistant history on cold /retry-stronger and serializes concurrent owner DMs", async () => {
    const seenHistories: Array<Array<{ role: "user" | "assistant"; content: string }>> = [];
    const router = new OwnerChannelStewardRouter({
      steward: {
        async converse(input) {
          await new Promise((r) => setTimeout(r, 15));
          seenHistories.push(input.history ?? []);
          return { ok: true, intent: "llm_agent", reply: `reply:${input.text}` };
        },
        async retryLastTurnStronger() {
          return { ok: true, intent: "llm_agent", reply: "retried-without-local-history" };
        },
      },
    });

    const coldRetry = await router.tryHandleInbound({
      channel: "weixin",
      peerId: "owner-serial",
      isGroup: false,
      isOwnerPeer: true,
      text: "/retry-stronger",
    });
    expect(coldRetry.handled).toBe(true);

    const [r1, r2] = await Promise.all([
      router.tryHandleInbound({ channel: "weixin", peerId: "owner-serial", isGroup: false, isOwnerPeer: true, text: "第一句" }),
      router.tryHandleInbound({ channel: "weixin", peerId: "owner-serial", isGroup: false, isOwnerPeer: true, text: "第二句" }),
    ]);
    expect(r1.handled).toBe(true);
    expect(r2.handled).toBe(true);
    // 首轮历史必须为空（未混入孤立 assistant 消息），次轮串行读取到首轮完整的 2 条 [user, assistant]
    expect(seenHistories[0]).toEqual([]);
    expect(seenHistories[1]).toEqual([
      { role: "user", content: "第一句" },
      { role: "assistant", content: "reply:第一句" },
    ]);
  });
});
