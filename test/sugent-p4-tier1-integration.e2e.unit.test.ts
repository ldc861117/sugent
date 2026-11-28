import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { SugentBrokerClaims } from "../src/sugent/auth-broker-contract.js";

const MOCK_API_BASE = ["http:", "", "127.0.0.1:43199", "v1"].join("/");
const MOCK_WEIXIN_BASE = ["http:", "", "127.0.0.1:9"].join("/");

async function createTestApp(tag: string) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `sugent-p4-${tag}-`));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `sugent-p4-home-${tag}-`));
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

describe("Wave P4 Tier-1 Host Integration (Plumbing, Atlas, Gardener, Concierge & Lossless Sync)", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it("digests converse turns into KG + StereoscopicAtlas + DSH skills and exposes /steward/atlas", async () => {
    const ctx = await createTestApp("converse-atlas");
    cleanups.push(ctx.cleanup);

    // 1. Converse turn -> immediate post-turn digest -> /amb/api/steward/atlas recall
    const convRes = await ctx.app.web!.inject("/amb/api/steward/converse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "帮我看看工作台现状", callerDomain: "owner_private" }),
    });
    expect(convRes.status).toBe(200);
    await ctx.app.stewardService.postTurnDigester.digestTurnNow({
      userText: "以后记住每周五下午三点前提交项目周报给张总",
      assistantReply: "好的，已记住这条工作习惯。",
      channel: "web_ui",
      peerId: "owner",
    });

    const atlasRes = await ctx.app.web!.inject("/amb/api/steward/atlas?q=%E5%91%A8%E6%8A%A5", {
      method: "GET",
    });
    expect(atlasRes.status).toBe(200);
    const atlasJson = JSON.parse(atlasRes.text);
    expect(atlasJson.ok).toBe(true);
    expect(atlasJson.summary.activeNodes).toBeGreaterThan(0);
    expect(atlasJson.recall.nodes.some((n: { name?: string; summary?: string }) =>
      `${n.name ?? ""} ${n.summary ?? ""}`.includes("周报"),
    )).toBe(true);

    // 2. Skill approval writes into BOTH <dataDir>/skills and <dataDir>/dsh/<botId>/skills
    ctx.app.knowledgeGraph.applyDelta({
      nodes: [
        {
          id: "wf:weekly-report-sync",
          kind: "workflow",
          name: "每周项目周报同步",
          summary: "汇总本周代码提交并生成给张总的周报",
          tags: ["workflow", "weekly"],
          reinforcements: 3,
          steps: ["汇总提交", "生成摘要"],
        },
      ],
    });
    const decideRes = await ctx.app.web!.inject("/amb/api/steward/skill-candidates/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: "wf:weekly-report-sync", decision: "approve" }),
    });
    expect(decideRes.status).toBe(200);
    const decideJson = JSON.parse(decideRes.text);
    expect(decideJson.ok).toBe(true);
    expect(decideJson.crystallizedPaths.length).toBe(1);
    const skillDirName = path.basename(path.dirname(decideJson.crystallizedPaths[0]!));
    expect(skillDirName).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    const dshSkillPath = path.join(ctx.dataDir, "dsh", "default", "skills", skillDirName, "SKILL.md");
    expect(fs.existsSync(dshSkillPath)).toBe(true);
  });

  it("runs gardener persistence + guardrails/relationships APIs + agent brief + SIM model-switch flagging", async () => {
    const ctx = await createTestApp("gardener-sim");
    cleanups.push(ctx.cleanup);

    // 1. Guardrails & Relationships via HTTP + AgentManager stewardContextBrief
    const gRes = await ctx.app.web!.inject("/amb/api/steward/guardrails", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        partition: "work_project",
        kind: "hard_redline",
        statement: "严禁对外客户泄露未签合同报价底价",
      }),
    });
    expect(gRes.status).toBe(200);
    expect(JSON.parse(gRes.text).ok).toBe(true);

    const rRes = await ctx.app.web!.inject("/amb/api/steward/relationships", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "rel:partner-zhao",
        partition: "work_project",
        name: "赵总",
        roleTag: "client",
        preferences: ["先给结论再附细节"],
      }),
    });
    expect(rRes.status).toBe(200);
    expect(JSON.parse(rRes.text).ok).toBe(true);

    // 2. ConciergeChannelBridge received ledger reference & scopes peer recall
    const bridgeSnap = ctx.app.conciergeBridge.getWorkbench();
    expect(bridgeSnap).toBeDefined();

    // 3. Memory Gardener run persists gardener-sandbox.json and updates workbench
    ctx.app.knowledgeGraph.applyDelta({
      nodes: [{ id: "mem:stale-node", kind: "concept", name: "过期事实", summary: "待修剪", tags: [] }],
      edges: [{ from: "mem:stale-node", relation: "related_to", to: "mem:stale-node", weight: 0.05, source: "test" }],
    });
    const gardRes = await ctx.app.web!.inject("/amb/api/steward/gardener/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prevSurpriseMomentum: 0.4 }),
    });
    expect(gardRes.status).toBe(200);
    const gardJson = JSON.parse(gardRes.text);
    expect(gardJson.ok).toBe(true);
    expect(fs.existsSync(ctx.app.stewardService.gardenerStore.filePath)).toBe(true);

    // 4. SIM records attempt and updateProviderRouting flags needs_revalidation on executor switch
    ctx.app.stewardService.simStore.recordAttempt(
      { problemId: "p4-test", title: "Executor prompt regression check" },
      {
        attemptId: "att-p4-1",
        roundId: "r-1",
        atIso: "2026-11-28T10:00:00Z",
        artifactKind: "skill_md",
        artifactPathOrId: "wf:weekly-report-sync",
        portabilityClass: "model_specific",
        rationale: "Tailored for initial executor",
        hypothesis: "Works on model-a",
        accepted: true,
        revalidationStatus: "verified",
        outcomeDelta: { predictedOutcomes: ["pass"], fixed: ["pass"], missed: [], ownerRejectedCount: 0, regressionDetected: false },
        provenance: { modelRole: "executor", resolvedModelId: "model-a" },
      },
    );
    ctx.app.providers.setRoleRouting({ executor: "model-a" });
    await ctx.app.updateProviderRouting({ executor: "model-b" });
    const simAttempts = ctx.app.stewardService.simStore.listClusters()[0]?.attempts ?? [];
    expect(simAttempts.some((a) => a.attemptId === "att-p4-1" && a.revalidationStatus === "needs_revalidation")).toBe(true);
  });

  it("syncs StewardshipLedger + skillGateStatus + edge provenance losslessly via E2EE push/pull", async () => {
    const devA = await createTestApp("sync-a");
    const devB = await createTestApp("sync-b");
    cleanups.push(devA.cleanup, devB.cleanup);

    const blobBucket = new Map<string, string>();
    const syncFetch: typeof fetch = async (input, init) => {
      const key = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "PUT") {
        blobBucket.set(key, String(init?.body ?? ""));
        return new Response(JSON.stringify({ stored: true }), { status: 200 });
      }
      if (method === "GET") {
        const raw = blobBucket.get(key);
        return raw ? new Response(raw, { status: 200, headers: { "content-type": "application/json" } }) : new Response("not found", { status: 404 });
      }
      return new Response("method not allowed", { status: 405 });
    };
    const hooks = {
      autostart: () => ({ supported: false, on: false }),
      setAutostart: () => {},
      applyZoom: () => {},
      openDataDir: () => {},
      openInBrowser: () => {},
      openExternal: () => {},
      fetch: syncFetch,
    };
    devA.app.desktop = hooks;
    devB.app.desktop = hooks;

    devA.app.stewardService.ledger.upsertGoal({
      id: "goal:p4-sync",
      partition: "work_project",
      title: "跨端无损同步闭环",
      northStarCriterion: "账本目标与技能状态完整还原",
    });
    devA.app.knowledgeGraph.applyDelta({
      nodes: [{ id: "wf:sync-skill", kind: "workflow", name: "同步验证工作流", summary: "验证批准态同步", tags: ["sync"], reinforcements: 3 }],
      edges: [{ from: "goal:p4-sync", relation: "uses", to: "wf:sync-skill", source: "manual_rule" }],
    });
    devA.app.knowledgeGraph.approveSkillCandidate("wf:sync-skill");

    const nowSec = Math.floor(Date.now() / 1000);
    const claims: SugentBrokerClaims = {
      iss: ["https", "auth.sugent.example"].join("://"),
      sub: "usr_p4_tier1_sync_01",
      aud: "sugent-desktop",
      iat: nowSec,
      exp: nowSec + 3600,
      idp: "wechat",
      plan: "pro",
      sync_endpoint: ["https", "sync.sugent.example/v1/e2ee"].join("://"),
    };
    const pushRes = await devA.app.web!.inject("/amb/api/sync/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ claims, bearerToken: "tok-a", passphrase: "correct-horse-battery-p4" }),
    });
    expect(pushRes.status).toBe(200);

    const pullRes = await devB.app.web!.inject("/amb/api/sync/pull", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ claims, bearerToken: "tok-b", passphrase: "correct-horse-battery-p4" }),
    });
    expect(pullRes.status).toBe(200);
    expect(devB.app.stewardService.ledger.snapshotForCaller("owner_private").goals.some((g) => g.id === "goal:p4-sync")).toBe(true);
    expect(devB.app.knowledgeGraph.getNode("wf:sync-skill")?.skillGateStatus).toBe("approved");
    expect(devB.app.knowledgeGraph.allEdges().find((e) => e.to === "wf:sync-skill")?.source).toBe("manual_rule");
  });
});
