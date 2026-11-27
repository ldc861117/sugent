import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConciergeChannelBridge,
  LocalBudgetLedger,
  OpsBridgeClient,
  OwnerChannelStewardRouter,
  SugentKnowledgeGraph,
  SugentStewardHostService,
} from "../src/sugent/index.js";

const HTTP_SCHEME = ["http", "://"].join("");
const DOCKER_ENVOY = `${HTTP_SCHEME}agent-wechat:6174`;

describe("Wave P3 End-to-End Integration — Dual-WeChat Concierge, Group Scribe & Public Envoy", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("wires WeChatEnvoyPoller -> GroupChatScribe (silent) & ConciergeChannelBridge (@mention -> owner card -> approved group reply)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-p3-e2e-"));
    tmpDirs.push(dir);

    const ownerNotices: string[] = [];
    const envoyOutbound: Array<{ chatId: string; text: string }> = [];

    const kg = new SugentKnowledgeGraph(path.join(dir, "kg"));
    const budgets = new LocalBudgetLedger(path.join(dir, "budgets"));

    let hostRef!: SugentStewardHostService;
    const bridge = new ConciergeChannelBridge({
      dataDir: dir,
      knowledgeGraph: kg,
      resolveActorRole: () => "external_peer",
      defaultTransport: {
        notifyOwner: async (_ch, text) => {
          ownerNotices.push(text);
        },
        sendPeerDirectMessage: async (ch, peerId, text) => {
          if (ch === "wechat_envoy") {
            await hostRef.wechatEnvoyClient.sendMessage({ chatId: peerId, text });
          }
        },
      },
    });
    bridge.updateConfig({ enabled: true, ownerDisplayName: "吕总", coolingWindowMs: 20 });

    const syncPayloads: Array<Record<string, unknown>> = [];
    const opsBridge = new OpsBridgeClient({
      baseUrl: "https://andylyu.com",
      nodeToken: "ops-tok",
      nodeId: "gce-hub",
      opsNodeId: "gce-airtoken",
      stewardHubNodeId: "gce-hub",
      fetchImpl: async (input, init) => {
        const u = String(input);
        if (u.endsWith("/api/ops/node/auth")) {
          return new Response(JSON.stringify({ bridgeJwt: "jwt-1", expiresInSec: 3600 }), { status: 200 });
        }
        if (u.includes("/api/ops/bridge/steward-pending")) {
          return new Response(
            JSON.stringify({
              projects: [],
              pendingInbox: [],
              publicConciergeQueue: [
                {
                  sessionId: "vis-101",
                  actorLabel: "远洋集团赵总",
                  intentSummary: "希望预约下周三船坞现场诊断演示",
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (u.endsWith("/api/ops/bridge/steward-sync")) {
          syncPayloads.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response("{}", { status: 404 });
      },
    });

    hostRef = new SugentStewardHostService({
      dataDir: dir,
      knowledgeGraph: kg,
      localBudgets: budgets,
      conciergeBridge: bridge,
      opsBridge,
      wechatEnvoyEnv: {
        SUGENT_WECHAT_ENVOY_ENABLED: "true",
        SUGENT_WECHAT_ENVOY_URL: DOCKER_ENVOY,
        SUGENT_WECHAT_ENVOY_TOKEN: "envoy-sec",
        SUGENT_WECHAT_ENVOY_SELF_WXID: "wxid_sugent_bot",
        SUGENT_WECHAT_ENVOY_SELF_ALIASES: "Sugent助理",
        SUGENT_WECHAT_ENVOY_ALLOW_DMS: "wxid_vip_client",
        SUGENT_WECHAT_ENVOY_ALLOW_GROUPS: "shipyard_proj@chatroom",
      },
      wechatEnvoyFetch: async (input, init) => {
        const u = String(input);
        if (u.includes("/api/events")) {
          return new Response(
            JSON.stringify({
              nextCursor: "cur-2",
              events: [
                {
                  id: "ev-silent-1",
                  chatId: "shipyard_proj@chatroom",
                  isGroup: true,
                  senderId: "wx_wang",
                  senderName: "王处长",
                  text: "我本周五前把涂装工位异常工单汇总发群里。汇报时千万别提去年旧系统延期那件事！",
                },
                {
                  id: "ev-mention-1",
                  chatId: "shipyard_proj@chatroom",
                  isGroup: true,
                  senderId: "wx_li",
                  senderName: "李经理",
                  text: "@Sugent助理 请问吕总下周二下午方便开个 30 分钟启动会吗？",
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (u.endsWith("/api/messages/send")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { chatId: string; text: string };
          envoyOutbound.push({ chatId: body.chatId, text: body.text });
          return new Response(JSON.stringify({ messageId: "out-1" }), { status: 200 });
        }
        return new Response("{}", { status: 404 });
      },
      nowIso: () => "2026-11-26T09:00:00.000Z",
    });

    // 1. Poll WeChat Envoy sidecar once
    const cycle = await hostRef.pollWeChatEnvoyOnce();
    expect(cycle.ok).toBe(true);
    expect(cycle.routedGroupSilent).toBe(1);
    expect(cycle.routedConcierge).toBe(1);
    expect(hostRef.groupScribe.outboundGroupMessagesSent).toBe(0);

    // 2. Owner receives earpiece card for the @mention in shipyard_proj@chatroom and approves option A
    const wbConcierge = bridge.getWorkbench();
    expect(wbConcierge.cards).toHaveLength(1);
    const mentionCard = wbConcierge.cards[0]!;
    expect(mentionCard.channel).toBe("wechat_envoy");
    expect(mentionCard.peerId).toBe("shipyard_proj@chatroom");

    const cmdOut = await bridge.executeOwnerCommand(
      `/send A ${mentionCard.cardId} ${mentionCard.draftA.confirmHash}`,
      "wechat_envoy",
    );
    expect(cmdOut.status).toBe("cooling_off_scheduled");
    await new Promise((r) => setTimeout(r, 60));
    expect(envoyOutbound).toHaveLength(1);
    expect(envoyOutbound[0]?.chatId).toBe("shipyard_proj@chatroom");

    // 3. Distill silent group digest and approve via OwnerChannelStewardRouter (/gdig ok <id>)
    const digest = await hostRef.distillGroupScribeDigest({
      groupId: "shipyard_proj@chatroom",
      groupName: "船厂FDE项目群",
    });
    expect(hostRef.getWorkbench("owner_private").groupDigests).toHaveLength(1);
    expect(hostRef.getWorkbench("work_project").groupDigests).toBeUndefined();

    const router = new OwnerChannelStewardRouter({ steward: hostRef });
    const gdigRes = await router.tryHandleInbound({
      channel: "weixin",
      peerId: "owner-wx",
      isGroup: false,
      isOwnerPeer: true,
      text: `/gdig ok ${digest.digestId}`,
    });
    expect(gdigRes.handled).toBe(true);
    expect(gdigRes.reply).toContain("已批准群纪要");
    const snap = hostRef.ledger.snapshotForCaller("owner_private");
    expect(snap.commitments.some((c) => c.direction === "waiting_for")).toBe(true);
    expect(snap.relationships.find((r) => r.name === "王处长")?.taboos.length).toBeGreaterThan(0);

    // 4. Refresh /ops publicConciergeQueue and reply via /pub <sessionId> <reply>
    await hostRef.refreshRemoteOpsSnapshot();
    expect(hostRef.getPublicConciergeQueue()).toHaveLength(1);
    const pubRes = await router.tryHandleInbound({
      channel: "weixin",
      peerId: "owner-wx",
      isGroup: false,
      isOwnerPeer: true,
      text: "/pub vis-101 赵总您好，下周三下午两点我带队到现场为您演示。",
    });
    expect(pubRes.handled).toBe(true);
    expect(syncPayloads[0]?.conciergeDecisions).toEqual([
      {
        sessionId: "vis-101",
        action: "approve_reply",
        ownerReply: "赵总您好，下周三下午两点我带队到现场为您演示。",
      },
    ]);
    expect(hostRef.getPublicConciergeQueue()).toHaveLength(0);

    // 5. Owner forwards a merged chat record in WeChat DM (offline LLM fallback path)
    const fwdRes = await router.tryHandleInbound({
      channel: "weixin",
      peerId: "owner-wx",
      isGroup: false,
      isOwnerPeer: true,
      text: "[合并转发的聊天记录]\n韩总: 下周二把二期技术规格书发给你们审核",
    });
    expect(fwdRes.handled).toBe(true);
    expect(
      hostRef.ledger
        .snapshotForCaller("owner_private")
        .resources.some((r) => r.metadata.source === "weixin_forwarded"),
    ).toBe(true);
  });
});
