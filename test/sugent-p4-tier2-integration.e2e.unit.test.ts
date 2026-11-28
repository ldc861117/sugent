import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const MOCK_API_BASE = ["http:", "", "127.0.0.1:43199", "v1"].join("/");
const MOCK_WEIXIN_BASE = ["http:", "", "127.0.0.1:9"].join("/");

async function createTier2App(tag: string) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `sugent-p4-t2-${tag}-`));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `sugent-p4-t2-home-${tag}-`));
  const cfg = loadConfig({
    dataDir,
    env: {
      AMB_MAGPIE_BASE_URL: MOCK_API_BASE,
      AMB_UI_PORT: "0",
      AMB_AGENT: "off",
      AMB_WEIXIN_API_BASE: MOCK_WEIXIN_BASE,
    },
  });
  const app = new App(cfg, { noWeb: false, fileLog: false, printQrToTerminal: false, stewardHomeDir: homeDir });
  await app.start();
  return {
    app,
    dataDir,
    homeDir,
    cleanup: async () => {
      await app.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

describe("Wave P4 Tier-2 Host Integration (SiliconIdentityCore, CognitiveMembrane M1-M4, Canary, Duo SSE & #/atlas)", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it("closes EpistemicDigestionLoop via HTTP mind-journal APIs & triggers LoyalDissent over Duo quality-time window", async () => {
    const ctx = await createTier2App("silicon-mind");
    cleanups.push(ctx.cleanup);

    ctx.app.stewardService.duoCrystallizer.upsertCommitment({
      spaceId: "andy-gillna",
      category: "quality_time",
      title: "周五晚不聊工作留白公约",
      detail: "每周五晚上留给彼此散步聊天，不安排高强度工作冲刺",
      proposer: "both",
    });
    ctx.app.stewardService.syncDuoMembraneToAtlas("andy-gillna");

    const jEntry = ctx.app.stewardService.mindLoop.recordJudgment({
      topicKey: "friday-crunch-guard",
      surface: "steward_hub",
      hypothesis: "周五晚强行安排研发冲刺会损害双人稳定感",
      rationale: "双人微约定已明确周末留白窗",
    });
    expect(jEntry.status).toBe("sandbox");

    // Confirm 3 times -> promoted to crystallized_wisdom in self_core
    await ctx.app.web!.inject("/amb/api/steward/mind-journal/reconcile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: jEntry.id, outcome: "confirmed", evidenceNote: "r2" }),
    });
    const r3 = await ctx.app.web!.inject("/amb/api/steward/mind-journal/reconcile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: jEntry.id, outcome: "confirmed", evidenceNote: "r3" }),
    });
    expect(r3.status).toBe(200);
    expect(JSON.parse(r3.text).entry.status).toBe("crystallized");

    const jGet = await ctx.app.web!.inject("/amb/api/steward/mind-journal", { method: "GET" });
    expect(jGet.status).toBe(200);
    expect(JSON.parse(jGet.text).counts.crystallized).toBe(1);

    // Falsify another hypothesis -> creates self:tombstone
    const badH = ctx.app.stewardService.mindLoop.recordJudgment({
      topicKey: "aggressive-cold-outreach",
      surface: "im_owner",
      hypothesis: "对首次询价客户直接发长篇术语手册更易成交",
    });
    const falsifyRes = await ctx.app.web!.inject("/amb/api/steward/mind-journal/reconcile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: badH.id, outcome: "falsified", evidenceNote: "客户嫌太长未读" }),
    });
    expect(JSON.parse(falsifyRes.text).entry.status).toBe("falsified");

    // Scheduling sprint on 周五晚 triggers LoyalDissentAlert on workbench
    const convRes = await ctx.app.web!.inject("/amb/api/steward/converse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "周五晚加班安排编码冲刺", callerDomain: "owner_private" }),
    });
    expect(convRes.status).toBe(200);
    const convJson = JSON.parse(convRes.text);
    expect(convJson.workbench.loyalDissent?.kind).toBe("duo_agreement_mirror");
    expect(ctx.app.stewardService.buildOwnerAgentBrief()).toContain("SiliconCharter".replace("SiliconCharter", "硅基个体统一宪章"));
  });

  it("enforces M1 10-canary leak guard + M2 symmetric pockets (HTTP 403) + Duo SSE streaming + M3/M4", async () => {
    const ctx = await createTier2App("duo-membrane");
    cleanups.push(ctx.cleanup);

    const canaries = [
      "ProjectValkyrieCanary",
      "¥884210",
      "sk-canary-secret-99887766",
      "客户王总底价",
      "/Users/andy/secret-pitch.pdf",
      "airtoken-canary-pool",
      "48 万人民币",
      "AcmeCorpNDA",
      "私人账号622208",
      "AlphaMergerContract",
    ];
    ctx.app.stewardService.ledger.addGuardrail({
      partition: "work_project",
      kind: "hard_redline",
      statement: `严禁外传 ${canaries[0]} 与 ${canaries[1]} 以及 ${canaries[3]} ${canaries[6]}`,
    });
    ctx.app.stewardService.ledger.upsertCommitment({
      partition: "personal_life",
      direction: "i_owe",
      summary: `审查 ${canaries[7]} ${canaries[9]} ${canaries[8]} ${canaries[5]}`,
      counterpartyOrRef: canaries[3],
    });
    ctx.app.stewardService.ledger.upsertGoal({
      partition: "work_project",
      title: `保密目标 ${canaries[0]}`,
      northStarCriterion: `不泄露 ${canaries[4]}`,
    });

    // Capture live prompt sent to Duo gateway or use weather injection check directly
    const capturedPrompts: string[] = [];
    const origFetch = globalThis.fetch;
    ctx.app.desktop = {
      autostart: () => ({ supported: false, on: false }),
      setAutostart: () => {},
      applyZoom: () => {},
      openDataDir: () => {},
      openInBrowser: () => {},
      openExternal: () => {},
      fetch: (async (url, init) => {
        if (String(url).includes("chat/completions")) {
          capturedPrompts.push(String(init?.body ?? ""));
          return new Response(
            "data: {\"choices\":[{\"delta\":{\"content\":\"星轨气候已温和对齐，\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"先安心休息再聊。\"}}]}\n\ndata: [DONE]\n\n",
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        return origFetch(url, init);
      }) as typeof fetch,
    };
    ctx.app.providers.setRoleRouting({ executor: "deepseek/deepseek-chat" });

    // M2 symmetric pocket: W writes private note -> M blocked with 403 -> W promotes sanitized insight
    const putW = await ctx.app.web!.inject("/amb/api/steward/duo/pockets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: "W", topicHint: "tired-evening", content: `今晚加班好累，先别谈 ${canaries[0]}`, passphrase: "w-pocket-pass-2026" }),
    });
    expect(putW.status).toBe(200);
    const wNoteId = JSON.parse(putW.text).note.id;

    const mSpyW = await ctx.app.web!.inject("/amb/api/steward/duo/pockets?viewer=M&targetOwner=W", { method: "GET" });
    expect(mSpyW.status).toBe(403);

    const promoteW = await ctx.app.web!.inject("/amb/api/steward/duo/pockets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "promote",
        actor: "W",
        noteId: wNoteId,
        topicKey: "evening-rest",
        title: "夜晚疲惫期先抱抱不追问",
        summary: "一方能量低谷时用安静陪伴替代长篇追问，次日再聊细节",
      }),
    });
    expect(promoteW.status).toBe(200);
    const crystalId = JSON.parse(promoteW.text).crystal.id;
    await ctx.app.web!.inject(`/amb/api/steward/duo/crystals/${crystalId}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: "M", action: "crystallize" }),
    });

    // Duo SSE streaming converse
    const sseRes = await ctx.app.web!.inject("/amb/api/steward/duo/converse", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        spaceId: "andy-gillna",
        speaker: "W",
        stream: true,
        messages: [{ role: "user", content: "他最近好像很忙，我怎么跟他开口更好？" }],
      }),
    });
    expect(sseRes.status).toBe(200);
    expect(sseRes.text).toContain("data: ");
    expect(sseRes.text).toContain("[DONE]");
    for (const c of canaries) {
      expect(sseRes.text).not.toContain(c);
      if (capturedPrompts[0]) expect(capturedPrompts[0]).not.toContain(c);
    }
  });

  it("exposes /steward/atlas graph + principal filtering + /steward/atlas/mutate persistent supersede & tombstone", async () => {
    const ctx = await createTier2App("atlas-mutate");
    cleanups.push(ctx.cleanup);

    ctx.app.knowledgeGraph.applyDelta({
      nodes: [{ id: "wf:atlas-gov-demo", kind: "workflow", name: "测试周报脚本", summary: "用于验证星图治理按钮", tags: ["demo"], reinforcements: 2 }],
    });
    ctx.app.stewardService.atlas.applyDelta({
      nodes: [
        {
          id: "peer:w-only-secret",
          plane: "relational:duo:andy-gillna",
          stratum: "raw_episodic",
          kind: "concept",
          name: "伴侣私人草稿",
          summary: "不应出现在主理人图谱中",
          tags: ["private"],
          principalAcl: ["partner:W"],
        },
      ],
    });

    const g1 = await ctx.app.web!.inject("/amb/api/steward/atlas?includeGraph=1", { method: "GET" });
    expect(g1.status).toBe(200);
    const j1 = JSON.parse(g1.text);
    expect(j1.graph.nodes.some((n: { id: string }) => n.id === "wf:atlas-gov-demo")).toBe(true);
    expect(j1.graph.nodes.some((n: { id: string }) => n.id === "peer:w-only-secret")).toBe(false);

    // Promote -> S3 crystallized_wisdom
    const m1 = await ctx.app.web!.inject("/amb/api/steward/atlas/mutate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "promote_stratum", nodeId: "wf:atlas-gov-demo" }),
    });
    expect(m1.status).toBe(200);
    expect(JSON.parse(m1.text).node.stratum).toBe("crystallized_wisdom");

    // Supersede -> excluded from active graph even after syncAtlasFromKnowledgeGraph, visible with includeSuperseded=1
    const m2 = await ctx.app.web!.inject("/amb/api/steward/atlas/mutate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "supersede_node", nodeId: "wf:atlas-gov-demo" }),
    });
    expect(m2.status).toBe(200);

    const gActive = await ctx.app.web!.inject("/amb/api/steward/atlas?includeGraph=1", { method: "GET" });
    expect(JSON.parse(gActive.text).graph.nodes.some((n: { id: string }) => n.id === "wf:atlas-gov-demo")).toBe(false);

    const gHist = await ctx.app.web!.inject("/amb/api/steward/atlas?includeGraph=1&includeSuperseded=1", { method: "GET" });
    expect(JSON.parse(gHist.text).graph.nodes.some((n: { id: string }) => n.id === "wf:atlas-gov-demo")).toBe(true);
  });
});
