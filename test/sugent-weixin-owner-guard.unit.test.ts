import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { App, type DesktopHooks } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { InboundEvent, OutboundOp } from "../src/core/types.js";
import { evaluateWeixinSingleHolderGuard } from "../src/sugent/ops-bridge-client.js";

const MOCK_API_BASE = ["http:", "", "127.0.0.1:43199", "v1"].join("/");
const MOCK_WEIXIN_BASE = ["http:", "", "127.0.0.1:9"].join("/");
const MOCK_OPS_BASE = ["https:", "", "ops.sugent.internal"].join("/");

function makeDesktopStub(fetchImpl: typeof fetch): DesktopHooks {
  return {
    autostart: () => ({ supported: false, on: false }),
    setAutostart: () => {},
    applyZoom: () => {},
    openDataDir: () => {},
    openInBrowser: () => {},
    openExternal: () => {},
    fetch: fetchImpl,
  };
}

describe("Weixin Single-Holder Guard & GCE Steward <-> /ops WeChat Loop", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it("evaluates single-holder guard accurately across standalone, local-mac, and gce-hub modes", () => {
    // 1. Standalone mode (neither OPS_BASE_URL nor SUGENT_WEIXIN_OWNER_NODE set) -> allowed
    const standalone = evaluateWeixinSingleHolderGuard({});
    expect(standalone.blocked).toBe(false);

    // 2. Fleet mode on local-mac -> blocked because gce-hub is the sole Weixin owner
    const localFleet = evaluateWeixinSingleHolderGuard({
      OPS_BASE_URL: MOCK_OPS_BASE,
      SUGENT_NODE_ID: "local-mac",
    });
    expect(localFleet.blocked).toBe(true);
    expect(localFleet.ownerNodeId).toBe("gce-hub");

    // 3. Explicit SUGENT_WEIXIN_OWNER_NODE=gce-hub on gce-hub -> allowed
    const hubNode = evaluateWeixinSingleHolderGuard({
      OPS_BASE_URL: MOCK_OPS_BASE,
      SUGENT_NODE_ID: "gce-hub",
      SUGENT_WEIXIN_OWNER_NODE: "gce-hub",
    });
    expect(hubNode.blocked).toBe(false);
  });

  it("blocks Weixin polling and QR login on local-mac when gce-hub holds Weixin ownership", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-wx-guard-"));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-wx-home-"));
    let weixinPollCalls = 0;

    const cfg = loadConfig({
      dataDir,
      env: {
        AMB_MAGPIE_BASE_URL: MOCK_API_BASE,
        AMB_UI_PORT: "0",
        AMB_AGENT: "off",
        AMB_WEIXIN_API_BASE: MOCK_WEIXIN_BASE,
      },
    });
    const app = new App(cfg, {
      noWeb: true,
      fileLog: false,
      printQrToTerminal: false,
      stewardHomeDir: homeDir,
      opsEnv: {
        OPS_BASE_URL: MOCK_OPS_BASE,
        SUGENT_NODE_ID: "local-mac",
        SUGENT_WEIXIN_OWNER_NODE: "gce-hub",
      },
      weixinFetch: (async () => {
        weixinPollCalls += 1;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });

    app.store.saveWeixinAccount({
      botId: "default",
      botToken: "wx-tok-saved",
      ilinkBotId: "wx-bot-1",
      baseUrl: MOCK_WEIXIN_BASE,
      ownerUserId: "wx-owner-1",
    });
    app.store.saveChannelAccount({
      key: "default",
      channel: "weixin",
      label: "WeChat",
      defaultBot: "default",
      enabled: true,
      credentials: {},
      createdAt: Date.now(),
    });

    await app.start();
    cleanups.push(async () => {
      await app.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    });

    // Weixin channel must NOT have started on local-mac
    expect(app.channels.get("default")?.weixin).toBeUndefined();
    expect(weixinPollCalls).toBe(0);

    const status = app.channelStatus("default");
    expect(status.weixin.state).toBe("disabled");
    expect(String(status.weixin.detail ?? "")).toContain("gce-hub");

    // Attempting to scan QR login on local-mac must throw clear guard error
    expect(() => app.startWeixinLogin("default")).toThrow(/gce-hub/);
  });

  it("bridges gce-hub Steward global /ops snapshot, stages ops_inbox approvals, and dispatches /ok <id> to ops_commands", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-gce-hub-"));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-gce-home-"));
    const syncedPayloads: Array<Record<string, unknown>> = [];
    const llmSeenPrompts: string[] = [];

    const mockFetch: typeof fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/ops/node/auth")) {
        return new Response(JSON.stringify({ token: "jwt-gce", expiresInSec: 3600 }), { status: 200 });
      }
      if (url.endsWith("/api/ops/bridge/steward-pending")) {
        return new Response(
          JSON.stringify({
            ok: true,
            projects: [
              {
                projectKey: "repo:owner/airtoken",
                displayName: "AirToken",
                nodeId: "local-mac",
                status: "Milestone 2 contract tests passing, awaiting GCE deploy",
                updatedAtIso: "2026-11-24T14:00:00.000Z",
              },
            ],
            pendingInbox: [
              {
                id: "inb-plan-01",
                title: "Sugent 下周重点排期",
                summary: "优先推进 ACP 编码适配器与隐藏 Git 快照",
                targetNodeId: "local-mac",
                commandAction: "sync_weekly_plan",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/api/ops/bridge/steward-sync")) {
        syncedPayloads.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes("/api/ops/bridge/")) {
        return new Response(JSON.stringify({ ok: true, commands: [] }), { status: 200 });
      }
      // LLM endpoint call
      const llmReq = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ content?: string }> };
      llmSeenPrompts.push(JSON.stringify(llmReq.messages ?? []));
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "AirToken 目前已完成 M2 合约单测，下一步等待 GCE 部署。" } }],
          usage: { prompt_tokens: 100, completion_tokens: 25 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const cfg = loadConfig({
      dataDir,
      env: {
        AMB_MAGPIE_BASE_URL: MOCK_API_BASE,
        AMB_UI_PORT: "0",
        AMB_AGENT: "off",
        AMB_WEIXIN_API_BASE: MOCK_WEIXIN_BASE,
      },
    });
    const app = new App(cfg, {
      noWeb: true,
      fileLog: false,
      printQrToTerminal: false,
      stewardHomeDir: homeDir,
      enableOwnerStewardRouter: true,
      opsEnv: {
        OPS_BASE_URL: MOCK_OPS_BASE,
        OPS_NODE_TOKEN: "tok-gce-hub",
        SUGENT_NODE_ID: "gce-hub",
        SUGENT_WEIXIN_OWNER_NODE: "gce-hub",
      },
    });
    app.desktop = makeDesktopStub(mockFetch);
    await app.start();
    cleanups.push(async () => {
      await app.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    });

    app.providers.upsertProvider({
      id: "byok-gce",
      name: "GCE BYOK",
      preset: "openai",
      baseUrl: MOCK_API_BASE,
      apiKey: "tok-gce-llm",
      models: ["gpt-5-mini"],
      defaultModel: "gpt-5-mini",
      enabled: true,
      setDefault: true,
    });
    app.store.saveWeixinAccount({
      botId: "default",
      botToken: "wx-tok-gce",
      ilinkBotId: "wx-bot-gce",
      baseUrl: MOCK_WEIXIN_BASE,
      ownerUserId: "wx-owner-001",
    });

    // 1. Run pulse tick on gce-hub -> pulls global /ops snapshot including AirToken & pending inbox
    await app.runStewardPulseTick();

    // 2. Owner asks in WeChat: "airtoken 现在到哪了？" -> LLM prompt includes global /ops AirToken status
    const askOps: OutboundOp[] = [];
    const askEv: InboundEvent = {
      id: "wx-msg-1",
      receivedAt: Date.now(),
      botId: "default",
      account: "default",
      channel: "weixin",
      conversation: { id: "wx-owner-001", kind: "dm" },
      sender: { id: "wx-owner-001", name: "Owner" },
      parts: [{ type: "text", text: "airtoken 现在到哪了？" }],
      replyHandle: {},
    };
    await app.runtime.handle(askEv, { apply: async (op) => { askOps.push(op); } });
    expect(llmSeenPrompts[0]).toContain("AirToken");
    expect(llmSeenPrompts[0]).toContain("Milestone 2 contract tests passing");

    // 3. Owner replies "/ok inb-plan-01" in WeChat -> approves inbox item and writes command to ops_commands via stewardSync
    const okOps: OutboundOp[] = [];
    const okEv: InboundEvent = {
      id: "wx-msg-2",
      receivedAt: Date.now() + 50,
      botId: "default",
      account: "default",
      channel: "weixin",
      conversation: { id: "wx-owner-001", kind: "dm" },
      sender: { id: "wx-owner-001", name: "Owner" },
      parts: [{ type: "text", text: "/ok inb-plan-01" }],
      replyHandle: {},
    };
    await app.runtime.handle(okEv, { apply: async (op) => { okOps.push(op); } });
    expect(okOps.some((o) => o.type === "text" && o.text.includes("inb-plan-01"))).toBe(true);
    expect(syncedPayloads.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(syncedPayloads)).toContain("local-mac");

    // 4. Proposing a high-risk item (funds/contract) forces /ops dashboard confirmation and blocks WeChat /ok
    const riskDraft = await app.stewardService.proposeOpsInbox({
      title: "签署供应商年度合同并打款",
      summary: "涉及外部付款与法务条款",
      targetNodeId: "local-mac",
    });
    expect(riskDraft.ok).toBe(true);
    const riskId = String(riskDraft.inboxId);
    const blockedApprove = await app.stewardService.approveOpsInbox(riskId);
    expect(blockedApprove.ok).toBe(false);
    expect(blockedApprove.handled).toBe(true);
    expect(String(blockedApprove.reply ?? "")).toContain("/ops");

    // 5. Mobile WeChat voice-to-text trailing punctuation ("同意。") approves single staged routine item cleanly
    app.stewardService.setRemoteOpsSnapshot({
      projects: [],
      pendingInbox: [
        {
          id: "inb-voice-02",
          title: "整理本周测试报告摘要",
          targetNodeId: "local-mac",
        },
      ],
    });
    const voiceOps: OutboundOp[] = [];
    const voiceEv: InboundEvent = {
      id: "wx-msg-3",
      receivedAt: Date.now() + 100,
      botId: "default",
      account: "default",
      channel: "weixin",
      conversation: { id: "wx-owner-001", kind: "dm" },
      sender: { id: "wx-owner-001", name: "Owner" },
      parts: [{ type: "text", text: "同意。" }],
      replyHandle: {},
    };
    await app.runtime.handle(voiceEv, { apply: async (op) => { voiceOps.push(op); } });
    expect(voiceOps.some((o) => o.type === "text" && o.text.includes("inb-voice-02"))).toBe(true);
  });
});
