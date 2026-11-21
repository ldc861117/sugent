import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { InboundEvent } from "../src/core/types.js";

const HTTP_PROTO = ["http", "://"].join("");
const LOOPBACK = ["127", "0", "0", "1"].join(".");

function createConciergeApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-concierge-bridge-"));
  const cfg = loadConfig({
    dataDir,
    env: {
      AMB_MAGPIE_BASE_URL: `${HTTP_PROTO}${LOOPBACK}:43198/v1`,
      AMB_UI_PORT: "0",
      AMB_AGENT: "off",
      AMB_WEIXIN_API_BASE: `${HTTP_PROTO}${LOOPBACK}:9`,
    },
  });
  const app = new App(cfg, { printQrToTerminal: false, fileLog: false });
  app.runtime.listModels = async () => ["deepseek-chat"];
  return { app, dataDir };
}

describe("Track B: P1 OPC Concierge Channel Bridge & /amb/api/concierge/* E2E", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!;
      await fn();
    }
  });

  const callApi = async (app: App, pathname: string, method = "GET", body?: unknown) => {
    const res = await app.web!.inject(`/amb/api${pathname}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: res.status,
      text: res.text,
      json: res.text ? JSON.parse(res.text) : {},
    };
  };

  it("intercepts WeChat/Feishu stranger DM, group chat, and whitelisted SOP without auto-replying by default", async () => {
    const { app, dataDir } = createConciergeApp();
    await app.start();
    cleanups.push(async () => {
      await app.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    });

    // Seed WeChat owner account so AccessControl knows owner = wx_owner_001
    app.store.saveWeixinAccount({
      botId: "default",
      botToken: "tok-wx-demo",
      ilinkBotId: "ilink_demo",
      baseUrl: `${HTTP_PROTO}${LOOPBACK}:9`,
      ownerUserId: "wx_owner_001",
    });

    // Seed multi-peer knowledge graph nodes (including another peer's confidential token)
    app.knowledgeGraph.applyDelta({
      nodes: [
        {
          id: "peer:wx_vip_01",
          kind: "person",
          name: "张总监",
          summary: "华东制造业数字化老客户",
          tags: ["peer:wx_vip_01"],
        },
        {
          id: "peer:wx_other_secret",
          kind: "person",
          name: "李行长",
          summary: "内部底价 CANARY_SECRET_7788 绝密条款",
          tags: ["peer:wx_other_secret"],
        },
      ],
      edges: [],
    });

    const ownerNotifications: Array<{ channel: string; text: string }> = [];
    const outboundPeerMessages: Array<{ channel: string; peerId: string; text: string }> = [];
    app.conciergeBridge.setTransportOverride({
      notifyOwner: async (channel, text) => {
        ownerNotifications.push({ channel, text });
      },
      sendToPeer: async (channel, peerId, text) => {
        outboundPeerMessages.push({ channel, peerId, text });
      },
    });

    // 1. Default status should be disabled (zero intrusion on existing behavior)
    const initialStatus = await callApi(app, "/concierge/status");
    expect(initialStatus.status).toBe(200);
    expect(initialStatus.json.enabled).toBe(false);

    // 2. Enable OPC Concierge mode via PUT /amb/api/concierge/config
    const updatedCfg = await callApi(app, "/concierge/config", "PUT", {
      enabled: true,
      ownerDisplayName: "吕总",
      cloudMode: "cloud_sanitized",
      coolingWindowMs: 80,
      explicitAssistantWhitelistPeerIds: ["wx_vip_01"],
    });
    expect(updatedCfg.status).toBe(200);
    expect(updatedCfg.json.enabled).toBe(true);

    // 3. Stranger DM arrives on WeChat -> intercepted silently (no refusal ack!), Whisper Earpiece pushed to owner
    const strangerEv: InboundEvent = {
      id: "msg_stranger_1",
      channel: "weixin",
      botId: "default",
      account: "default",
      conversation: { kind: "dm", id: "wx_stranger_99" },
      sender: { id: "wx_stranger_99", name: "王总" },
      parts: [{ type: "text", text: "你好，想了解企业顾问合作档期" }],
      replyHandle: {},
      receivedAt: Date.now(),
    };
    const interceptedStranger = app.runtime.interceptReply(strangerEv);
    expect(interceptedStranger).toEqual({ handled: true });
    await app.conciergeBridge.flushPending();

    expect(outboundPeerMessages).toHaveLength(0);
    expect(ownerNotifications).toHaveLength(1);
    expect(ownerNotifications[0]!.text).toContain("幕僚耳麦");
    expect(ownerNotifications[0]!.text).not.toContain("CANARY_SECRET_7788");

    // Verify 0400 read-only context file sealed on disk
    const contextDir = path.join(dataDir, "concierge-workspace", ".context");
    const files = fs.readdirSync(contextDir).filter((f) => f.startsWith("event-"));
    expect(files.length).toBeGreaterThanOrEqual(1);
    const mode = fs.statSync(path.join(contextDir, files[0]!)).mode & 0o777;
    expect(mode).toBe(0o400);

    // 4. Group chat message -> G2 Group Silence Lock blocks group send and pushes private digest to owner
    const groupEv: InboundEvent = {
      id: "msg_group_1",
      channel: "feishu",
      botId: "default",
      account: "default",
      conversation: { kind: "group", id: "oc_group_alpha" },
      sender: { id: "ou_member_88", name: "赵经理" },
      parts: [{ type: "text", text: "大家下午好，下周评审会议定在周三吗？" }],
      replyHandle: {},
      receivedAt: Date.now(),
    };
    expect(app.runtime.interceptReply(groupEv)).toEqual({ handled: true });
    await app.conciergeBridge.flushPending();
    expect(outboundPeerMessages).toHaveLength(0);
    expect(ownerNotifications.at(-1)!.text).toContain("群聊保护生效");

    // 5. Whitelisted VIP peer sends low-risk FAQ -> schedules cooling-off auto reply; owner cancels with /undo
    const vipFaqEv1: InboundEvent = {
      id: "msg_vip_faq_1",
      channel: "weixin",
      botId: "default",
      account: "default",
      conversation: { kind: "dm", id: "wx_vip_01" },
      sender: { id: "wx_vip_01", name: "张总监" },
      parts: [{ type: "text", text: "请问咱们下周可以预约个会议演示标准流程吗？" }],
      replyHandle: {},
      receivedAt: Date.now(),
    };
    const outcome1 = await app.conciergeBridge.processInboundEvent(vipFaqEv1);
    expect(outcome1.routeTaken).toBe("explicit_digital_assistant");
    const dispatchId1 =
      outcome1.routeTaken === "explicit_digital_assistant" ? outcome1.dispatchId : "";
    expect(dispatchId1).toBeTruthy();

    // Owner cancels within cooling window via REST command endpoint
    const undoRes = await callApi(app, "/concierge/command", "POST", {
      commandText: `/undo ${dispatchId1}`,
    });
    expect(undoRes.status).toBe(200);
    expect(undoRes.json.outcome.status).toBe("canceled_in_cooling_window");

    await new Promise((r) => setTimeout(r, 110));
    expect(outboundPeerMessages).toHaveLength(0);

    // 6. Second whitelisted SOP without /undo -> delivered after cooling window with explicit assistant badge
    const vipFaqEv2: InboundEvent = {
      ...vipFaqEv1,
      id: "msg_vip_faq_2",
    };
    const outcome2 = await app.conciergeBridge.processInboundEvent(vipFaqEv2);
    expect(outcome2.routeTaken).toBe("explicit_digital_assistant");
    await new Promise((r) => setTimeout(r, 110));

    expect(outboundPeerMessages).toHaveLength(1);
    expect(outboundPeerMessages[0]!.peerId).toBe("wx_vip_01");
    expect(outboundPeerMessages[0]!.text).toContain("[由 吕总 的数字助理 Sugent 协办]");
    expect(outboundPeerMessages[0]!.text).not.toContain("CANARY_SECRET_7788");
  });
});
