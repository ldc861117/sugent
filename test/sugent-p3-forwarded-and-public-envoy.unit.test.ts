import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MessageItemType, type MessageItem } from "../src/channels/weixin/api.js";
import { extractForwardedRecordText, weixinParts } from "../src/channels/weixin/channel.js";
import { OpsBridgeClient } from "../src/sugent/ops-bridge-client.js";
import { StewardshipLedger } from "../src/sugent/stewardship-ledger.js";
import { ingestForwardedBriefingToLedger } from "../src/sugent/weixin-quota-and-briefing.js";

describe("Wave P3.2 — WeChat iLink merged-forward extraction & public concierge bridge", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("extracts structured record_item.items and strips control characters", () => {
    const item: MessageItem = {
      type: 49,
      record_item: {
        title: "与王总的聊天记录",
        items: [
          { sender_name: "王总\x07", content: "二期合同能不能降到 16 万，走 90 天账期？" },
          { sender_name: "我", content: "明天中午前我核对一下交付范围给您答复" },
        ],
      },
    };
    const out = extractForwardedRecordText(item);
    expect(out).toContain("[合并转发的聊天记录]");
    expect(out).toContain("王总: 二期合同能不能降到 16 万，走 90 天账期？");
    expect(out).not.toContain("\x07");
  });

  it("parses escaped <recorditem>/<dataitem> XML inside appmsg_item and pushes into weixinParts", () => {
    const escapedInner =
      "&lt;recordinfo&gt;&lt;datalist&gt;" +
      "&lt;dataitem&gt;&lt;sourcename&gt;周主任&lt;/sourcename&gt;&lt;datadesc&gt;周五前麻烦把诊断清单发我&lt;/datadesc&gt;&lt;/dataitem&gt;" +
      "&lt;/datalist&gt;&lt;/recordinfo&gt;";
    const item: MessageItem = {
      type: 6,
      appmsg_item: {
        title: "群聊的聊天记录",
        xml: `<appmsg><recorditem>${escapedInner}</recorditem></appmsg>`,
      },
    };
    const parts = weixinParts([item, { type: MessageItemType.TEXT, text_item: { text: "帮我看看这段怎么回" } }]);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({
      type: "text",
      text: "[合并转发的聊天记录]\n周主任: 周五前麻烦把诊断清单发我",
    });
    expect(parts[1]).toEqual({ type: "text", text: "帮我看看这段怎么回" });
  });

  it("extracts ref_msg carrying 聊天记录 title and truncates oversized bundles at 8000 chars", () => {
    const huge = `赵总: ${"A".repeat(8500)}`;
    const item: MessageItem = {
      type: MessageItemType.TEXT,
      text_item: { text: "请参谋" },
      ref_msg: { title: "[聊天记录]", content: huge },
    };
    const parts = weixinParts([item]);
    expect(parts[0]?.type).toBe("text");
    if (parts[0]?.type === "text") {
      expect(parts[0].text.startsWith("[合并转发的聊天记录]\n赵总: ")).toBe(true);
      expect(parts[0].text.length).toBeLessThanOrEqual(8000);
      expect(parts[0].text.endsWith("…")).toBe(true);
    }
    expect(parts[1]).toEqual({ type: "text", text: "请参谋" });
  });

  it("ingests forwarded briefing into StewardshipLedger idempotently and honors autoRecordToLedger:false", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-p32-fwd-"));
    tmpDirs.push(dir);
    const ledger = new StewardshipLedger({ dataDir: dir });
    ledger.addGuardrail({
      id: "gr-days",
      partition: "work_project",
      kind: "hard_redline",
      statement: "账期不得超过 60 天，严禁零首付",
    });

    const rawText = [
      "[合并转发的聊天记录]",
      "孙总: 下周三我把产线点检表发给你们，但合同想走零首付 90 天账期。",
      "我: 明天下午前我核对核算底线回复您。",
    ].join("\n");

    const previewOnly = ingestForwardedBriefingToLedger({
      workspaceDir: path.join(dir, "ws"),
      ledger,
      rawForwardedText: rawText,
      autoRecordToLedger: false,
    });
    expect(previewOnly.briefing.triggeredRedlines.length).toBeGreaterThan(0);
    expect(ledger.snapshotForCaller("owner_private").commitments).toHaveLength(0);

    const first = ingestForwardedBriefingToLedger({
      workspaceDir: path.join(dir, "ws"),
      ledger,
      rawForwardedText: rawText,
      nowIso: "2026-11-26T08:00:00.000Z",
    });
    expect(first.deduplicated).toBe(false);
    expect(first.recordedCommitments.some((c) => c.direction === "waiting_for")).toBe(true);
    expect(first.recordedCommitments.some((c) => c.direction === "i_owe")).toBe(true);
    expect(first.recordedResource?.kind).toBe("personal_archive");

    const second = ingestForwardedBriefingToLedger({
      workspaceDir: path.join(dir, "ws"),
      ledger,
      rawForwardedText: rawText,
      nowIso: "2026-11-26T08:05:00.000Z",
    });
    expect(second.deduplicated).toBe(true);
    expect(second.recordedCommitments).toHaveLength(0);
    expect(ledger.snapshotForCaller("owner_private").commitments).toHaveLength(first.recordedCommitments.length);
  });

  it("parses publicConciergeQueue in OpsBridgeClient.fetchFleetSnapshot and sends conciergeDecisions in stewardSync", async () => {
    const syncBodies: Array<Record<string, unknown>> = [];
    const client = new OpsBridgeClient({
      baseUrl: "https://andylyu.com",
      nodeToken: "tok-test",
      nodeId: "gce-hub",
      opsNodeId: "gce-airtoken",
      stewardHubNodeId: "gce-hub",
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/api/ops/node/auth")) {
          return new Response(JSON.stringify({ bridgeJwt: "jwt-ok", expiresInSec: 3600 }), { status: 200 });
        }
        if (url.includes("/api/ops/bridge/steward-pending")) {
          return new Response(
            JSON.stringify({
              projects: [],
              pendingInbox: [],
              publicConciergeQueue: [
                {
                  sessionId: "pub-sess-01",
                  actorLabel: "华东重工李总",
                  species: "human",
                  intentSummary: "咨询船厂异常诊断试点与排期",
                  contactEmail: "li@example.com",
                  matchedDomains: ["industrial_ai"],
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/api/ops/bridge/steward-sync")) {
          syncBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response("{}", { status: 404 });
      },
    });

    const snap = await client.stewardPending();
    expect(snap.ok).toBe(true);
    expect(snap.snapshot?.publicConciergeQueue).toHaveLength(1);
    expect(snap.snapshot?.publicConciergeQueue?.[0]?.actorLabel).toBe("华东重工李总");

    const synced = await client.stewardSync({
      conciergeDecisions: [
        { sessionId: "pub-sess-01", action: "approve_reply", ownerReply: "李总您好，本周四下午可安排线上交流。" },
      ],
    });
    expect(synced.ok).toBe(true);
    expect(syncBodies[0]?.conciergeDecisions).toEqual([
      { sessionId: "pub-sess-01", action: "approve_reply", ownerReply: "李总您好，本周四下午可安排线上交流。" },
    ]);
  });
});
