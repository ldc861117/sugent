import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WeChatEnvoyPoller,
  WeChatEnvoySidecarClient,
  assertSafeEnvoyTransportUrl,
  resolveWeChatEnvoyConfig,
} from "../src/sugent/wechat-envoy-sidecar.js";

const HTTP_SCHEME = ["http", "://"].join("");
const LOOPBACK_ENVOY = `${HTTP_SCHEME}127.0.0.1:6174`;
const DOCKER_ENVOY = `${HTTP_SCHEME}agent-wechat:6174`;

describe("Wave P3.3 — External agent-wechat Sidecar Client & Poller", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("enforces safe loopback/internal transport URLs and rejects cleartext public HTTP", () => {
    expect(assertSafeEnvoyTransportUrl(`${LOOPBACK_ENVOY}/`)).toBe(LOOPBACK_ENVOY);
    expect(assertSafeEnvoyTransportUrl(DOCKER_ENVOY)).toBe(DOCKER_ENVOY);
    expect(() => assertSafeEnvoyTransportUrl(`${HTTP_SCHEME}203.0.113.10:6174`)).toThrow(/Refusing cleartext HTTP/);
    expect(() => assertSafeEnvoyTransportUrl("https://envoy.example.com", false)).toThrow(/ALLOW_REMOTE_HTTPS/);
    expect(assertSafeEnvoyTransportUrl("https://envoy.example.com", true)).toBe("https://envoy.example.com");

    const cfg = resolveWeChatEnvoyConfig({
      SUGENT_WECHAT_ENVOY_ENABLED: "true",
      SUGENT_WECHAT_ENVOY_URL: DOCKER_ENVOY,
      SUGENT_WECHAT_ENVOY_TOKEN: "sec-tok",
      SUGENT_WECHAT_ENVOY_SELF_WXID: "wxid_bot_01",
      SUGENT_WECHAT_ENVOY_SELF_ALIASES: "@Sugent助理, 小助手",
      SUGENT_WECHAT_ENVOY_ALLOW_DMS: "wxid_client_a,wxid_client_b",
      SUGENT_WECHAT_ENVOY_ALLOW_GROUPS: "1001@chatroom",
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.selfAliases).toEqual(["Sugent助理", "小助手"]);
    expect(cfg.allowedGroupIds).toEqual(["1001@chatroom"]);
  });

  it("stays 100% silent with zero network calls when unconfigured, and enforces 6/min per-chat rate limit", async () => {
    let calls = 0;
    const offClient = new WeChatEnvoySidecarClient(
      { enabled: false },
      { fetchFn: async () => (++calls, new Response("{}")) },
    );
    expect(offClient.isConfigured()).toBe(false);
    expect(await offClient.getStatus()).toEqual({ ok: false, skipped: true });
    expect(calls).toBe(0);

    let nowMs = 1_700_000_000_000;
    const liveClient = new WeChatEnvoySidecarClient(
      { enabled: true, baseUrl: LOOPBACK_ENVOY, apiToken: "tok-1" },
      {
        nowFn: () => nowMs,
        fetchFn: async (input) => {
          const u = String(input);
          if (u.endsWith("/api/status")) return new Response("not found", { status: 404 });
          if (u.endsWith("/api/accounts")) {
            return new Response(JSON.stringify({ accounts: [{ wxid: "wxid_bot", nickname: "Sugent助理", online: true }] }), { status: 200 });
          }
          if (u.endsWith("/api/messages/send")) {
            return new Response(JSON.stringify({ messageId: `m-${++calls}` }), { status: 200 });
          }
          return new Response("{}", { status: 404 });
        },
      },
    );

    const st = await liveClient.getStatus();
    expect(st.ok && st.loggedIn && st.selfWxid === "wxid_bot").toBe(true);

    for (let i = 0; i < 6; i += 1) {
      const r = await liveClient.sendMessage({ chatId: "wxid_peer", text: `msg-${i}` });
      expect(r.ok).toBe(true);
    }
    const seventh = await liveClient.sendMessage({ chatId: "wxid_peer", text: "burst" });
    expect(seventh.ok).toBe(false);
    if (!seventh.ok && !("skipped" in seventh && seventh.skipped)) {
      expect(seventh.rateLimited).toBe(true);
    }
    nowMs += 61_000;
    expect((await liveClient.sendMessage({ chatId: "wxid_peer", text: "after-window" })).ok).toBe(true);
  });

  it("falls back to /api/chats + /api/messages/{chatId}, gates DMs/groups/@mentions, seals 0o400 envelopes, and persists 0o600 cursor", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-p33-poller-"));
    tmpDirs.push(dir);

    const client = new WeChatEnvoySidecarClient(
      { enabled: true, baseUrl: LOOPBACK_ENVOY, apiToken: "tok-envoy" },
      {
        fetchFn: async (input) => {
          const u = String(input);
          if (u.includes("/api/events")) return new Response("no events endpoint", { status: 404 });
          if (u.endsWith("/api/chats")) {
            return new Response(
              JSON.stringify({
                chats: [
                  { chatId: "1001@chatroom", unreadCount: 3 },
                  { chatId: "9999@chatroom", unreadCount: 1 },
                  { chatId: "wxid_partner", unreadCount: 1 },
                ],
              }),
              { status: 200 },
            );
          }
          if (u.endsWith("/api/messages/1001@chatroom")) {
            return new Response(
              JSON.stringify({
                messages: [
                  { id: "m-self", chatId: "1001@chatroom", senderId: "wxid_bot", text: "echo", fromSelf: true },
                  { id: "m-silent", chatId: "1001@chatroom", senderId: "wxid_alice", senderName: "Alice", text: "我周五前把接口文档发群里" },
                  {
                    id: "m-at",
                    chatId: "1001@chatroom",
                    senderId: "wxid_bob",
                    senderName: "Bob",
                    text: "@Sugent助理 请问下周二下午能排一次联调吗？",
                    cwd: "./override-dir",
                    permission: "bypass",
                  },
                ],
              }),
              { status: 200 },
            );
          }
          if (u.endsWith("/api/messages/9999@chatroom")) {
            return new Response(
              JSON.stringify({ messages: [{ id: "m-unlisted-grp", chatId: "9999@chatroom", senderId: "u1", text: "@Sugent助理 hi" }] }),
              { status: 200 },
            );
          }
          if (u.endsWith("/api/messages/wxid_partner")) {
            return new Response(
              JSON.stringify({ messages: [{ id: "m-dm-1", chatId: "wxid_partner", senderId: "wxid_partner", senderName: "张总", text: "发我一份产品介绍手册" }] }),
              { status: 200 },
            );
          }
          return new Response("{}", { status: 404 });
        },
      },
    );

    const silentMsgs: string[] = [];
    const actionablePaths: string[] = [];
    const strippedSnapshots: string[][] = [];
    const cfg = resolveWeChatEnvoyConfig({
      SUGENT_WECHAT_ENVOY_ENABLED: "true",
      SUGENT_WECHAT_ENVOY_TOKEN: "tok-envoy",
      SUGENT_WECHAT_ENVOY_SELF_WXID: "wxid_bot",
      SUGENT_WECHAT_ENVOY_SELF_ALIASES: "Sugent助理",
      SUGENT_WECHAT_ENVOY_ALLOW_DMS: "wxid_partner",
      SUGENT_WECHAT_ENVOY_ALLOW_GROUPS: "1001@chatroom",
    });

    const poller = new WeChatEnvoyPoller({
      config: cfg,
      client,
      dataDir: dir,
      onGroupSilentMessage: (m) => {
        silentMsgs.push(m.messageId);
      },
      onActionableInbound: (ev) => {
        strippedSnapshots.push(ev.envelope.strippedFields);
        actionablePaths.push(ev.envelope.absoluteFilePath);
      },
    });

    const cycle1 = await poller.runCycleOnce();
    expect(cycle1.ok).toBe(true);
    expect(cycle1.droppedSelf).toBe(1);
    expect(cycle1.droppedPolicy).toBe(1);
    expect(cycle1.routedGroupSilent).toBe(1);
    expect(cycle1.routedConcierge).toBe(2);
    expect(silentMsgs).toEqual(["m-silent"]);
    expect(actionablePaths).toHaveLength(2);
    expect(strippedSnapshots[0]).toEqual(expect.arrayContaining(["cwd", "permission"]));
    for (const p of actionablePaths) {
      expect(fs.statSync(p).mode & 0o777).toBe(0o400);
    }

    const statePath = path.join(dir, "sugent-stewardship", "wechat-envoy-state.json");
    expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);

    const poller2 = new WeChatEnvoyPoller({ config: cfg, client, dataDir: dir });
    const cycle2 = await poller2.runCycleOnce();
    expect(cycle2.deduplicated).toBe(5);
    expect(cycle2.routedConcierge).toBe(0);
  });

  it("provides hardened compose.wechat-envoy.yml with 384m cap, shared loopback namespace, and label-scoped auto-updater", () => {
    const composeText = fs.readFileSync(
      path.resolve("deploy", "gce-hub", "compose.wechat-envoy.yml"),
      "utf8",
    );
    expect(composeText).toContain("mem_limit: 384m");
    expect(composeText).toContain('network_mode: "service:sugent-hub"');
    expect(composeText).toContain("no-new-privileges:true");

    const mainCompose = fs.readFileSync(path.resolve("deploy", "gce-hub", "compose.yml"), "utf8");
    expect(mainCompose).toContain("com.centurylinklabs.watchtower.enable=true");
    expect(mainCompose).toContain('WATCHTOWER_LABEL_ENABLE: "true"');

    const readmeText = fs.readFileSync(path.resolve("deploy", "gce-hub", "README.md"), "utf8");
    expect(readmeText).toContain("双微信号「前店后厂」");
  });

  it("supports agent-wechat-native /v1 SSE stream, live freshness filter, serverId rotation reset, and Idempotency-Key receipt recovery", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-p33-v1-"));
    tmpDirs.push(dir);

    const nowMs = 1_764_200_000_000;
    let currentServerId = "srv_epoch_1";
    let sendPostCount = 0;
    let simulateSend502Once = true;
    const seenSendIdempKeys: string[] = [];

    const v1Client = new WeChatEnvoySidecarClient(
      { enabled: true, baseUrl: `${LOOPBACK_ENVOY}/v1`, apiToken: "tok-v1" },
      {
        nowFn: () => nowMs,
        fetchFn: async (input, init) => {
          const u = String(input);
          if (u.endsWith("/v1/status")) {
            return new Response(
              JSON.stringify({ online: true, serverId: currentServerId }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          if (u.endsWith("/v1/accounts")) {
            return new Response(
              JSON.stringify([{ id: "acct_envoy_01", wxid: "wxid_envoy", nickname: "Sugent助理", online: true }]),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          if (u.includes("/v1/events/stream")) {
            const sseBody = [
              'id: 101\nevent: message.committed\ndata: {"messageId":"m_catchup","origin":"catchup"}',
              'id: 102\nevent: message.committed\ndata: {"messageId":"m_stale","origin":"live"}',
              'id: 103\nevent: message.committed\ndata: {"messageId":"m_recalled","origin":"live"}',
              'id: 104\nevent: message.recalled\ndata: {"messageId":"m_recalled"}',
              'id: 105\nevent: message.committed\ndata: {"messageId":"m_live_ok","origin":"live"}',
              "",
            ].join("\n\n");
            return new Response(sseBody, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            });
          }
          if (u.endsWith("/v1/messages/m_catchup")) {
            return new Response(
              JSON.stringify({ id: "m_catchup", chatId: "wxid_client_1", senderId: "wxid_client_1", text: "历史同步消息", timestampMs: nowMs - 10_000, origin: "catchup" }),
              { status: 200 },
            );
          }
          if (u.endsWith("/v1/messages/m_stale")) {
            return new Response(
              JSON.stringify({ id: "m_stale", chatId: "wxid_client_1", senderId: "wxid_client_1", text: "10分钟前的积压消息", timestampMs: nowMs - 10 * 60_000, origin: "live" }),
              { status: 200 },
            );
          }
          if (u.endsWith("/v1/messages/m_recalled")) {
            return new Response(
              JSON.stringify({ id: "m_recalled", chatId: "wxid_client_1", senderId: "wxid_client_1", text: "刚发完就撤回", timestampMs: nowMs - 2_000, origin: "live" }),
              { status: 200 },
            );
          }
          if (u.endsWith("/v1/messages/m_live_ok")) {
            return new Response(
              JSON.stringify({ id: "m_live_ok", chatId: "wxid_client_1", senderId: "wxid_client_1", senderName: "李总", text: "明天下午方便通个电话吗？", timestampMs: nowMs - 5_000, origin: "live" }),
              { status: 200 },
            );
          }
          if (u.endsWith("/v1/accounts/acct_envoy_01/sends") && init?.method === "POST") {
            sendPostCount += 1;
            const hdrs = new Headers(init.headers);
            const ik = hdrs.get("idempotency-key") ?? "";
            seenSendIdempKeys.push(ik);
            if (simulateSend502Once) {
              simulateSend502Once = false;
              return new Response(JSON.stringify({ error: "gateway_timeout" }), { status: 502 });
            }
            return new Response(JSON.stringify({ sendId: "snd_2", messageId: "wx_out_2", status: "accepted" }), { status: 200 });
          }
          if (u.includes("/v1/accounts/acct_envoy_01/sends/by-idempotency-key/")) {
            return new Response(
              JSON.stringify({ sendId: "snd_1", messageId: "wx_out_1", status: "accepted" }),
              { status: 200 },
            );
          }
          return new Response("{}", { status: 404 });
        },
      },
    );

    const status = await v1Client.getStatus();
    expect(status.ok && status.serverId === "srv_epoch_1" && status.accountId === "acct_envoy_01").toBe(true);

    const cfg = resolveWeChatEnvoyConfig({
      SUGENT_WECHAT_ENVOY_ENABLED: "true",
      SUGENT_WECHAT_ENVOY_TOKEN: "tok-v1",
      SUGENT_WECHAT_ENVOY_SELF_WXID: "wxid_envoy",
      SUGENT_WECHAT_ENVOY_ALLOW_DMS: "wxid_client_1",
    });

    const actionableIds: string[] = [];
    const poller = new WeChatEnvoyPoller({
      config: cfg,
      client: v1Client,
      dataDir: dir,
      onActionableInbound: (ev) => {
        actionableIds.push(ev.message.messageId);
      },
    });

    const c1 = await poller.runCycleOnce();
    expect(c1.ok).toBe(true);
    expect(c1.nextCursor).toBe("105");
    expect(c1.serverId).toBe("srv_epoch_1");
    expect(actionableIds).toEqual(["m_live_ok"]);

    // Simulate Native server recreation (new serverId) -> must reset cursor safely without processing stale cursor
    currentServerId = "srv_epoch_2";
    const cRotate = await poller.runCycleOnce();
    expect(cRotate.ok).toBe(true);
    expect(cRotate.cursorResetOnServerChange).toBe(true);
    expect(cRotate.serverId).toBe("srv_epoch_2");
    expect(cRotate.nextCursor).toBeUndefined();

    // Test outbound 502 recovery via GET .../by-idempotency-key/{key} WITHOUT blind re-POST!
    const send1 = await v1Client.sendMessage({
      chatId: "wxid_client_1",
      text: "明天下午三点可以，我准时打给您。",
      idempotencyKey: "idem-fixed-001",
    });
    expect(send1.ok).toBe(true);
    if (send1.ok) {
      expect(send1.recoveredViaReceipt).toBe(true);
      expect(send1.messageId).toBe("wx_out_1");
    }
    expect(sendPostCount).toBe(1);
    expect(seenSendIdempKeys).toEqual(["idem-fixed-001"]);
  });
});
