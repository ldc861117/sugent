import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { SugentBrokerClaims } from "../src/sugent/auth-broker-contract.js";
import { verifyDuoFederationContract } from "../src/sugent/duo-federation-contract.js";
import { DuoStewardCrystallizer } from "../src/sugent/duo-steward-crystallizer.js";
import { SugentKnowledgeGraph } from "../src/sugent/knowledge-graph.js";
import { LocalBudgetLedger } from "../src/sugent/local-budget.js";
import {
  createDefaultBudgetState,
  drainBoundaryQueue,
  evaluateFlowAwareDelivery,
  gateProactiveCandidates,
  matchActiveDuoProtectedWindow,
  type DuoProtectedWindowAnchor,
  type ProactiveCandidate,
} from "../src/sugent/proactive-cadence.js";
import { resolveSugentGatewayConfig } from "../src/sugent/gateway.js";
import { SugentStewardHostService } from "../src/sugent/steward-host-service.js";

const MOCK_API_BASE = ["http:", "", "127.0.0.1:43199", "v1"].join("/");
const MOCK_WEIXIN_BASE = ["http:", "", "127.0.0.1:9"].join("/");

async function createLaneEApp(
  tag: string,
  extra?: { uiToken?: string; duoBridgeToken?: string },
) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `sugent-p5-le-${tag}-`));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `sugent-p5-le-home-${tag}-`));
  const cfg = loadConfig({
    dataDir,
    env: {
      AMB_MAGPIE_BASE_URL: MOCK_API_BASE,
      AMB_UI_PORT: "0",
      ...(extra?.uiToken ? { AMB_UI_TOKEN: extra.uiToken } : {}),
      AMB_AGENT: "off",
      AMB_WEIXIN_API_BASE: MOCK_WEIXIN_BASE,
    },
  });
  const app = new App(cfg, {
    noWeb: false,
    fileLog: false,
    printQrToTerminal: false,
    stewardHomeDir: homeDir,
    ...(extra?.duoBridgeToken
      ? { opsEnv: { SUGENT_DUO_BRIDGE_TOKEN: extra.duoBridgeToken } }
      : {}),
  });
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

describe("Wave P5 Lane E (P5.5): Duo Auto-Candidate, M3 Protected Window, Full-Loop Host & Federation Contract", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it("extracts debounced auto-candidate crystals with strict sovereignty gate (never auto-crystallized) & exposes symmetric M/W pocketSummary", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-p5-duo-auto-"));
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    let nowIso = "2026-11-28T10:00:00.000Z";
    const duo = new DuoStewardCrystallizer({
      dataDir: tmpDir,
      autoCandidateDebounceMs: 25,
      nowIso: () => nowIso,
    });
    cleanups.push(() => duo.dispose());

    // Symmetric M & W private pockets: 1 plain + 1 encrypted for M, 1 encrypted for W
    const mPlain = duo.pockets.putPrivateNote({
      spaceId: "andy-gillna",
      actor: "M",
      topicHint: "pace-note",
      content: "提醒自己忙的时候先发个抱抱表情再进会议",
    });
    duo.pockets.putPrivateNote({
      spaceId: "andy-gillna",
      actor: "M",
      topicHint: "inner-buffer",
      content: "这段冲刺期需要一点安静收口时间",
      passphrase: "pluto-secret-pass",
    });
    duo.pockets.putPrivateNote({
      spaceId: "andy-gillna",
      actor: "W",
      topicHint: "walk-wish",
      content: "周五晚饭后去江边走走最放松",
      passphrase: "charon-secret-pass",
    });
    duo.pockets.promoteNoteToSharedCandidate({
      spaceId: "andy-gillna",
      actor: "M",
      noteId: mPlain.id,
      topicKey: "busy-hug-signal",
      title: "忙碌前先发温暖在场信号",
      summary: "进入高密度事务前先给伴侣一个简短安心信号",
      duo,
    });

    const snapWithPockets = duo.getVaultSnapshot("andy-gillna");
    expect(snapWithPockets.pocketSummary).toEqual({
      M: { totalNotes: 2, encryptedNotes: 1, promotedCount: 1 },
      W: { totalNotes: 1, encryptedNotes: 1, promotedCount: 0 },
    });
    expect(JSON.stringify(snapWithPockets)).not.toContain("这段冲刺期需要一点安静收口时间");
    expect(JSON.stringify(snapWithPockets)).not.toContain("周五晚饭后去江边走走最放松");

    // Multi-turn resonance dialogue triggers debounced auto-candidate crystal
    await duo.converseAsDuoSteward({
      spaceId: "andy-gillna",
      speaker: "W",
      messages: [
        { role: "user", content: "每次周五晚上如果还在回工作消息，就会觉得周末好像没真正开始。" },
        { role: "assistant", content: "可以把周五晚饭设成一道温柔的分界线。" },
        { role: "user", content: "很有共鸣，以后咱们就约好周五晚不加班，留白不谈工作去散步！" },
      ],
    });
    const flushed1 = await duo.flushPendingAutoCrystallize("andy-gillna");
    expect(flushed1).toHaveLength(1);
    const autoCrys = flushed1[0]!;
    expect(autoCrys.status).toBe("candidate");
    expect(autoCrys.endorsedBy).toEqual([]);
    expect(autoCrys.reinforcements).toBe(1);

    // Repeat 4 more turns on the same topic -> deduplicated by topicKey, reinforcements capped < 3, NEVER auto-promoted!
    for (let i = 0; i < 4; i++) {
      nowIso = `2026-11-28T10:0${i + 1}:00.000Z`;
      await duo.streamConverseAsDuoSteward({
        spaceId: "andy-gillna",
        speaker: i % 2 === 0 ? "M" : "W",
        messages: [
          { role: "user", content: "我们约好周五晚不加班，留白不谈工作，这个默契真的很棒！" },
        ],
      });
      await duo.flushPendingAutoCrystallize("andy-gillna");
    }

    const vaultAfterSpam = duo.getVaultSnapshot("andy-gillna");
    const matchingCandidates = vaultAfterSpam.crystals.candidates.filter(
      (c) => c.topicKey === autoCrys.topicKey,
    );
    expect(matchingCandidates).toHaveLength(1);
    expect(matchingCandidates[0]!.status).toBe("candidate");
    expect(matchingCandidates[0]!.endorsedBy).toEqual([]);
    expect(matchingCandidates[0]!.reinforcements).toBeLessThan(3);
    expect(
      vaultAfterSpam.crystals.crystallized.some((c) => c.id === autoCrys.id),
    ).toBe(false);

    // Secret-like dialogue is rejected cleanly
    const secretAttempt = await duo.distillAutoCandidateFromDialogue({
      spaceId: "andy-gillna",
      speaker: "M",
      messages: [{ role: "user", content: "我们约好保存密钥 sk-1234567890abcdef1234567890abcdef" }],
    });
    expect(secretAttempt).toBeNull();

    // Co-endorsement by M + W promotes candidate to crystallized
    const afterM = duo.reviewCrystal({
      spaceId: "andy-gillna",
      crystalId: autoCrys.id,
      actor: "M",
      action: "endorse",
    });
    expect(afterM.status).toBe("candidate");
    const afterMW = duo.reviewCrystal({
      spaceId: "andy-gillna",
      crystalId: autoCrys.id,
      actor: "W",
      action: "endorse",
    });
    expect(afterMW.status).toBe("crystallized");
    expect(afterMW.endorsedBy).toEqual(["M", "W"]);
  });

  it("defers non-urgent work notifications during M3 Friday-evening protected window while passing urgent alerts, then drains cleanly afterwards", () => {
    // 1. Pure kernel window matching across weekday/time/date/offset cues
    const friWalkAnchor: DuoProtectedWindowAnchor = {
      id: "dcom-fri-walk",
      title: "周五晚不加班散步",
      detail: "每周五晚上留给彼此散步聊天",
      protectedWindowKeywords: ["周五", "晚上", "散步"],
    };
    expect(matchActiveDuoProtectedWindow("2026-11-27T20:00:00+08:00", [friWalkAnchor])).toMatchObject({
      active: true,
      matchedAnchorId: "dcom-fri-walk",
    });
    expect(matchActiveDuoProtectedWindow("2026-11-27T10:30:00+08:00", [friWalkAnchor]).active).toBe(false);
    expect(matchActiveDuoProtectedWindow("2026-11-26T20:30:00+08:00", [friWalkAnchor]).active).toBe(false);
    expect(matchActiveDuoProtectedWindow("2026-11-28T09:30:00+08:00", [friWalkAnchor]).active).toBe(false);
    expect(
      matchActiveDuoProtectedWindow("2026-12-25T20:15:00Z", [
        { id: "anniv", title: "纪念日晚餐", protectedWindowKeywords: ["2026-12-25", "20:00"] },
      ]).active,
    ).toBe(true);
    expect(
      matchActiveDuoProtectedWindow("2026-12-25T23:00:00Z", [
        { id: "anniv", title: "纪念日晚餐", protectedWindowKeywords: ["2026-12-25", "20:00"] },
      ]).active,
    ).toBe(false);

    const mkCand = (id: string, urgency: "normal" | "urgent"): ProactiveCandidate => ({
      candidateId: id,
      dedupeKey: `dedupe:${id}`,
      kind: urgency === "urgent" ? "fleet_collision_or_alert" : "review_ready",
      urgency,
      title: `Candidate ${id}`,
      threeLineBody: ["L1", "L2", "L3"],
      targetRefId: `ref:${id}`,
    });

    const baseBudget = createDefaultBudgetState("2026-11-27");
    const flowFridayNight = evaluateFlowAwareDelivery(
      [mkCand("work-review", "normal"), mkCand("prod-red-alert", "urgent")],
      baseBudget,
      { mode: "co_working", activeGoalId: "ref:work-review", duoProtectedAnchors: [friWalkAnchor] },
      "2026-11-27T20:00:00+08:00",
    );
    expect(flowFridayNight.emitNow.map((c) => c.candidateId)).toEqual(["prod-red-alert"]);
    expect(flowFridayNight.holdForBoundary.map((c) => c.candidateId)).toEqual(["work-review"]);

    const gatedFridayNight = gateProactiveCandidates(
      [mkCand("work-normal-2", "normal"), mkCand("urgent-2", "urgent")],
      flowFridayNight.nextState,
      { nowIso: "2026-11-27T20:15:00+08:00", duoProtectedAnchors: [friWalkAnchor] },
    );
    expect(gatedFridayNight.emitNow.map((c) => c.candidateId)).toEqual(["urgent-2"]);
    expect(gatedFridayNight.holdForBoundary?.map((c) => c.candidateId)).toEqual(["work-normal-2"]);
    expect(gatedFridayNight.nextState.boundaryQueue?.map((c) => c.candidateId)).toEqual([
      "work-review",
      "work-normal-2",
    ]);

    const afterWindow = drainBoundaryQueue(gatedFridayNight.nextState, () => false);
    expect(afterWindow.emitNow.map((c) => c.candidateId)).toEqual(["work-review", "work-normal-2"]);
    expect(afterWindow.nextState.boundaryQueue).toEqual([]);

    // 2. Host service integration: M3 duo anchor shields Friday 20:00 pulse & drains Saturday morning
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-p5-m3-host-"));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-p5-m3-home-"));
    let hostNowIso = "2026-11-27T20:00:00+08:00";
    const kg = new SugentKnowledgeGraph(path.join(dataDir, "sugent-kg"));
    const budgets = new LocalBudgetLedger(dataDir);
    const host = new SugentStewardHostService({
      dataDir,
      homeDir,
      knowledgeGraph: kg,
      localBudgets: budgets,
      nowIso: () => hostNowIso,
    });
    cleanups.push(() => {
      host.dispose();
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    });

    host.duoCrystallizer.upsertCommitment({
      spaceId: "andy-gillna",
      category: "quality_time",
      title: "周五晚不加班散步",
      detail: "每周五晚 19:30 起出门散步，不处理常规工作提醒",
      proposer: "both",
    });
    host.duoCrystallizer.pockets.putPrivateNote({
      spaceId: "andy-gillna",
      actor: "W",
      content: "周五晚想吃热汤面",
      passphrase: "w-key",
    });
    host.syncDuoMembraneToAtlas("andy-gillna");
    expect(host.getWorkbench("owner_private").duoSummary?.pocketSummary?.W.encryptedNotes).toBe(1);

    // Seed 1 normal waiting_review commitment + 1 urgent overdue commitment
    host.ledger.upsertCommitment(
      {
        id: "cmt:normal-pr",
        partition: "work_project",
        direction: "waiting_for",
        status: "waiting_review",
        summary: "常规周报草稿待审阅",
        counterpartyOrRef: "team-dev",
      },
      hostNowIso,
    );
    host.ledger.upsertCommitment(
      {
        id: "cmt:urgent-sla",
        partition: "work_project",
        direction: "i_owe",
        status: "open",
        summary: "线上故障修复回执超期",
        counterpartyOrRef: "ops-oncall",
        dueAt: "2026-11-26T10:00:00+08:00",
      },
      hostNowIso,
    );

    const pulseDuringWindow = host.runScheduledPulse();
    expect(pulseDuringWindow.scan.emitNow.map((c) => c.targetRefId)).toEqual(["cmt:urgent-sla"]);
    expect(pulseDuringWindow.boundaryDrain).toBeUndefined();
    expect(
      host.getWorkbench("owner_private").cadence.state.boundaryQueue?.map((c) => c.targetRefId),
    ).toEqual(["cmt:normal-pr"]);

    // Advance past Friday evening window -> Saturday morning 09:30 drains boundaryQueue cleanly!
    hostNowIso = "2026-11-28T09:30:00+08:00";
    const drainedAfterWindow = host.drainFlowBoundary();
    expect(drainedAfterWindow.emitNow.map((c) => c.targetRefId)).toEqual(["cmt:normal-pr"]);
    expect(drainedAfterWindow.workbench.cadence.state.boundaryQueue).toEqual([]);
  });

  it("unifies native Atlas PostTurnDigester, Tier-1 assessor implicit feedback, plane-aware Dropzone/3s briefing, and Gardener Sleep Consolidation", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-p5-host-unify-"));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-p5-home-unify-"));
    let nowIso = "2026-11-28T11:00:00.000Z";
    const kg = new SugentKnowledgeGraph(path.join(dataDir, "sugent-kg"));
    const budgets = new LocalBudgetLedger(dataDir);

    let assessorCalled = 0;
    const sandboxRef = { id: "" };
    const mockFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.model === "assessor-mini-v1") {
        assessorCalled += 1;
        return new Response(
          JSON.stringify({
            model: "assessor-mini-v1",
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    matches: [
                      {
                        id: sandboxRef.id,
                        outcome: "falsified",
                        confidence: 0.91,
                        evidenceNote: "委婉反馈差点被违约条款坑到",
                      },
                    ],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("offline", { status: 503 });
    };

    const host = new SugentStewardHostService({
      dataDir,
      homeDir,
      knowledgeGraph: kg,
      localBudgets: budgets,
      llmFetch: mockFetch,
      getGatewayConfig: () =>
        resolveSugentGatewayConfig(undefined, {
          SUGENT_GATEWAY_URL: MOCK_API_BASE,
          SUGENT_GATEWAY_KEY: "test-gw-key-safe",
          SUGENT_MODEL_ASSESSOR: "assessor-mini-v1",
          SUGENT_MODEL_STEWARD: "steward-offline",
        }),
      nowIso: () => nowIso,
    });
    cleanups.push(() => {
      host.dispose();
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    });

    // 1. Native PostTurnDigester + Tier-1 assessor implicit feedback reconciliation
    const hyp = host.mindLoop.recordJudgment(
      {
        topicKey: "contract-penalty-clause",
        surface: "steward_hub",
        hypothesis: "标准采购模板无需逐条复核延迟交付连带违约上限",
      },
      nowIso,
    );
    sandboxRef.id = hyp.id;

    const digestRes = await host.postTurnDigester.digestTurnNow({
      channel: "web_ui",
      peerId: "owner",
      projectKey: "contract-guard",
      userText: "以后记住跟华东大客户签约必须锁死违约金不超过合同总额百分之十。另外幸好法务多看了一眼，不然那份标准模板就吃哑巴亏了。",
      assistantReply: "已为您记录华东客户违约金上限红线并复盘教训。",
    });
    expect(digestRes.nativeAtlasNodes).toBeGreaterThanOrEqual(2);
    expect(digestRes.episodeAnchorId).toBeTruthy();
    expect(assessorCalled).toBe(1);
    expect(host.mindLoop.getMindJournalSnapshot().counts.falsified).toBe(1);

    // 2. Plane-aware Dropzone advise & 3s WeChat forwarded briefing hit domain_work:contract-guard + self_core tombstone
    host.runContractGuardPack({
      inquiryId: "inq-huadong-01",
      counterparty: "华东精密刘总",
      rawContractText: "结算账期为 90 天净账期，含无上限连带赔偿条款",
      requestedPaymentDays: 90,
    });

    const dropAdvise = await host.submitDropzone({
      channel: "web_ui",
      callerDomain: "owner_private",
      partition: "work_project",
      text: "华东精密刘总那边想把违约金和账期再放宽，我该怎么回、怎么权衡利弊？",
    });
    expect(dropAdvise.outcome.intent).toBe("advise");
    if (dropAdvise.outcome.intent === "advise") {
      const joinedAdvise = `${dropAdvise.outcome.tradeOffBrief}\n${dropAdvise.outcome.guardrailWarnings.join("\n")}`;
      expect(joinedAdvise).toMatch(/华东精密刘总|contract-penalty-clause|违约金/);
    }

    const briefing = host.briefForwardedWeixinChat({
      rawForwardedText: "华东精密刘总：咱们这次采购合同违约金条款按常规走、账期给到90天可以吧？",
    });
    expect((briefing.recalledAtlasRefs ?? []).length).toBeGreaterThan(0);

    // 3. Gardener Sleep Consolidation synthesizes >=3 coherent facts & surfaces conflict disambiguation cards
    host.atlas.applyDelta(
      {
        nodes: [
          {
            id: "fact:deploy:1",
            plane: "domain_work:sugent",
            stratum: "verified_fact",
            kind: "concept",
            name: "发布检查项一",
            summary: "发版前必须运行 typecheck 确保零类型错误",
            tags: ["topic:release-checklist"],
            principalAcl: ["sugent_self", "owner:M"],
          },
          {
            id: "fact:deploy:2",
            plane: "domain_work:sugent",
            stratum: "verified_fact",
            kind: "concept",
            name: "发布检查项二",
            summary: "发版前必须跑通 verify:sugent 架构契约门禁",
            tags: ["topic:release-checklist"],
            principalAcl: ["sugent_self", "owner:M"],
          },
          {
            id: "fact:deploy:3",
            plane: "domain_work:sugent",
            stratum: "verified_fact",
            kind: "concept",
            name: "发布检查项三",
            summary: "发版前确认 E2EE 跨端同步回归单测全绿",
            tags: ["topic:release-checklist"],
            principalAcl: ["sugent_self", "owner:M"],
          },
          {
            id: "fact:quote-conflict:a",
            plane: "domain_work:contract-guard",
            stratum: "verified_fact",
            kind: "preference",
            name: "北辰客户账期记录A",
            summary: "北辰项目合同结算净账期上限 30 天",
            tags: ["topic:beichen-payment"],
            principalAcl: ["sugent_self", "owner:M"],
          },
          {
            id: "fact:quote-conflict:b",
            plane: "domain_work:contract-guard",
            stratum: "verified_fact",
            kind: "preference",
            name: "北辰客户账期记录B",
            summary: "北辰项目合同结算净账期上限 60 天",
            tags: ["topic:beichen-payment"],
            principalAcl: ["sugent_self", "owner:M"],
          },
        ],
      },
      nowIso,
    );

    host.runGardener();
    const synNode = host.atlas.getNode("syn:domain_work:sugent:release-checklist");
    expect(synNode?.stratum).toBe("crystallized_wisdom");

    const wbOwner = host.getWorkbench("owner_private");
    expect((wbOwner.disambiguationCards ?? []).length).toBeGreaterThanOrEqual(1);
    expect(wbOwner.disambiguationCards?.[0]?.topicKey).toBe("beichen-payment");
    expect(host.getWorkbench("work_project").disambiguationCards).toBeUndefined();
  });

  it("completes full App HTTP lifecycle: 5-plane + mind-journal E2EE sync, /atlas/provenance S0 drill-down, and 100% bigfive-duo-site federation contract", async () => {
    const adminToken = "owner-admin-ui-secret-token-p5";
    const duoToken = "duo-federation-bridge-secret-token-2026";

    const devA = await createLaneEApp("dev-a", {
      uiToken: adminToken,
      duoBridgeToken: duoToken,
    });
    const devB = await createLaneEApp("dev-b", {
      uiToken: adminToken,
      duoBridgeToken: duoToken,
    });
    cleanups.push(devA.cleanup, devB.cleanup);

    // Wire shared in-memory E2EE blob store between Device A and Device B
    const cloudBlobStore = new Map<string, string>();
    const syncFetch: typeof fetch = async (input, init) => {
      const key = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "PUT") {
        cloudBlobStore.set(key, String(init?.body ?? ""));
        return new Response(JSON.stringify({ stored: true }), { status: 200 });
      }
      if (method === "GET") {
        const raw = cloudBlobStore.get(key);
        return raw
          ? new Response(raw, { status: 200, headers: { "content-type": "application/json" } })
          : new Response("not found", { status: 404 });
      }
      return new Response("method not allowed", { status: 405 });
    };
    const makeDesktopHooks = () => ({
      autostart: () => ({ supported: false, on: false }),
      setAutostart: () => {},
      applyZoom: () => {},
      openDataDir: () => {},
      openInBrowser: () => {},
      openExternal: () => {},
      fetch: syncFetch,
    });
    devA.app.desktop = makeDesktopHooks();
    devB.app.desktop = makeDesktopHooks();

    // 1. Seed S0 turns in both Web (steward-web-turns.jsonl via /steward/converse) & WeChat (SQLite messages)
    const ownerHeaders = {
      "content-type": "application/json",
      "x-amb-token": adminToken,
    };
    const webConvRes = await devA.app.web!.inject("/amb/api/steward/converse", {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({
        channel: "web_ui",
        callerDomain: "owner_private",
        text: "以后记住所有核心合同必须先查法务违约金上限红线",
      }),
    });
    expect(webConvRes.status).toBe(200);

    const webDigest = await devA.app.stewardService.postTurnDigester.digestTurnNow({
      channel: "web_ui",
      peerId: "owner",
      userText: "以后记住所有核心合同必须先查法务违约金上限红线",
      assistantReply: "已记入主理人核心红线。",
    });
    expect(webDigest.episodeAnchorId).toBeTruthy();

    // Seed a WeChat owner conversation in SQLite and digest into domain_work:contract-guard
    const wxPeerId = "wxid_owner_andy_01";
    const wxConv = devA.app.store.ensureConversation("default", "weixin", wxPeerId, "Andy", "dm");
    const wxTurnAtIso = devA.app.stewardService.atlas.getNode(webDigest.episodeAnchorId!)?.updatedAt ?? new Date().toISOString();
    const wxTurnMs = Date.parse(wxTurnAtIso);
    devA.app.store.db
      .prepare(
        "INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(wxConv.id, "user", "以后记住南山客户报价净账期锁死30天内结算", wxTurnMs);
    devA.app.store.db
      .prepare(
        "INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(wxConv.id, "assistant", "明白，南山客户30天净账期已落盘。", wxTurnMs + 500);

    const wxDigest = await devA.app.stewardService.postTurnDigester.digestTurnNow({
      channel: "weixin",
      peerId: wxPeerId,
      projectKey: "contract-guard",
      userText: "以后记住南山客户报价净账期锁死30天内结算",
      assistantReply: "明白，南山客户30天净账期已落盘。",
    });
    expect(wxDigest.nativeAtlasNodes).toBeGreaterThanOrEqual(2);

    const nanshanNode = devA.app.stewardService.atlas
      .allNodes()
      .find((n) => n.plane === "domain_work:contract-guard" && n.summary.includes("南山客户报价净账期"));
    expect(nanshanNode).toBeDefined();

    // Verify GET /amb/api/steward/atlas/provenance returns S0 WeChat & Web snippets for owner_private and blocks work_project / cowork_shared!
    const provWxOwner = await devA.app.web!.inject(
      `/amb/api/steward/atlas/provenance?nodeId=${encodeURIComponent(nanshanNode!.id)}`,
      { method: "GET", headers: { "x-amb-token": adminToken } },
    );
    expect(provWxOwner.status).toBe(200);
    const provWxJson = JSON.parse(provWxOwner.text);
    expect(provWxJson.ok).toBe(true);
    expect(provWxJson.allowed).toBe(true);
    expect(provWxJson.episodeNodes.length).toBeGreaterThanOrEqual(1);
    expect(
      provWxJson.transcriptSnippets.some(
        (s: { channel: string; snippet: string }) =>
          s.channel === "weixin" && s.snippet.includes("南山客户报价净账期锁死30天"),
      ),
    ).toBe(true);

    const webFactNode = devA.app.stewardService.atlas
      .allNodes()
      .find(
        (n) =>
          n.plane === "owner_life" &&
          n.id.startsWith("pref:turn-") &&
          n.summary.includes("法务违约金上限红线"),
      );
    expect(webFactNode).toBeDefined();
    const provWebOwner = await devA.app.web!.inject(
      `/amb/api/steward/atlas/provenance?nodeId=${encodeURIComponent(webFactNode!.id)}`,
      { method: "GET", headers: { "x-amb-token": adminToken } },
    );
    const provWebJson = JSON.parse(provWebOwner.text);
    expect(provWebJson.allowed).toBe(true);
    expect(
      provWebJson.transcriptSnippets.some(
        (s: { channel: string; snippet: string }) =>
          s.channel === "web_ui" && s.snippet.includes("法务违约金上限红线"),
      ),
    ).toBe(true);

    for (const nonOwnerDomain of ["work_project", "cowork_shared"] as const) {
      const blockedRes = await devA.app.web!.inject(
        `/amb/api/steward/atlas/provenance?nodeId=${encodeURIComponent(nanshanNode!.id)}&domain=${nonOwnerDomain}`,
        { method: "GET", headers: { "x-amb-token": adminToken } },
      );
      expect(blockedRes.status).toBe(200);
      const blockedJson = JSON.parse(blockedRes.text);
      expect(blockedJson.ok).toBe(false);
      expect(blockedJson.allowed).toBe(false);
      expect(blockedJson.errorCode).toBe("PROVENANCE_OWNER_ONLY");
      expect(blockedJson.transcriptSnippets).toEqual([]);
    }

    // 2. Populate all 5 Atlas planes + MindJournal + confidential owner canary on Device A
    const confidentialCanaries = ["ProjectHyperionCanary99", "¥960000", "/Users/andy/vault-floor.pdf"];
    devA.app.stewardService.ledger.addGuardrail({
      partition: "work_project",
      kind: "hard_redline",
      statement: `严禁外泄 ${confidentialCanaries[0]} 底价 ${confidentialCanaries[1]} (${confidentialCanaries[2]})`,
    });

    // Ensure meta_evolution + relational:duo + self_core + mind-journal all populated on Device A
    devA.app.stewardService.atlas.applyDelta({
      nodes: [
        {
          id: "wf:p5-meta-workflow",
          plane: "meta_evolution",
          stratum: "crystallized_wisdom",
          kind: "workflow",
          name: "跨端回归门禁流",
          summary: "先跑 typecheck 再跑校准评测集",
          tags: ["workflow", "p5"],
          principalAcl: ["sugent_self", "owner:M"],
          reinforcements: 3,
        },
      ],
    });
    const mindHyp = devA.app.stewardService.mindLoop.recordJudgment({
      id: "self:hyp:p5-sync-test",
      topicKey: "async-assessor-digestion",
      surface: "steward_hub",
      hypothesis: "回合后异步小模型消化能捕获委婉踩坑复盘",
      rationale: "Wave P5 实测验证",
    });
    devA.app.stewardService.mindLoop.reconcileOutcome({
      idOrTopic: mindHyp.id,
      outcome: "confirmed",
      evidenceNote: "端到端通过",
      ownerEndorsed: true,
    });

    // 3. Run 100% bigfive-duo-site federation contract verifier against Device A HTTP server
    const contractReport = await verifyDuoFederationContract({
      injectFn: (p, init) => devA.app.web!.inject(p, init),
      duoToken,
      spaceId: "andy-gillna",
      canaryTokens: confidentialCanaries,
    });
    expect(contractReport.checks).toHaveLength(5);
    for (const check of contractReport.checks) {
      expect(check, `Contract check failed: ${check.name} (${check.detail})`).toMatchObject({
        passed: true,
      });
    }
    expect(contractReport.ok).toBe(true);

    // Sync M3/M4 membrane edges into Device A's Atlas after co-endorsement in contract check #5
    devA.app.stewardService.syncDuoMembraneToAtlas("andy-gillna");

    const devASummary = devA.app.stewardService.atlas.getPlaneSummary();
    const planesOnA = Object.keys(devASummary.byPlane);
    expect(planesOnA.some((p) => p === "self_core")).toBe(true);
    expect(planesOnA.some((p) => p === "owner_life")).toBe(true);
    expect(planesOnA.some((p) => p.startsWith("relational:duo:"))).toBe(true);
    expect(planesOnA.some((p) => p.startsWith("domain_work:"))).toBe(true);
    expect(planesOnA.some((p) => p === "meta_evolution")).toBe(true);
    expect(devASummary.membraneBridgeCount).toBeGreaterThanOrEqual(1);

    // 4. Push E2EE SyncableAtlasSnapshot v2 + mind-journal from Device A -> Pull onto Device B!
    const nowSec = Math.floor(Date.now() / 1000);
    const claims: SugentBrokerClaims = {
      iss: ["https", "auth.sugent.example"].join("://"),
      sub: "usr_p5_lane_e_e2ee_01",
      aud: "sugent-desktop",
      iat: nowSec,
      exp: nowSec + 3600,
      idp: "wechat",
      plan: "pro",
      sync_endpoint: ["https", "sync.sugent.example/v1/e2ee"].join("://"),
    };

    const pushRes = await devA.app.web!.inject("/amb/api/sync/push", {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({
        claims,
        bearerToken: "tok-dev-a",
        passphrase: "p5-lossless-five-planes-passphrase",
      }),
    });
    expect(pushRes.status).toBe(200);

    const pullRes = await devB.app.web!.inject("/amb/api/sync/pull", {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({
        claims,
        bearerToken: "tok-dev-b",
        passphrase: "p5-lossless-five-planes-passphrase",
      }),
    });
    expect(pullRes.status).toBe(200);

    // Verify all 5 planes, membrane bridges, and mind-journal.json restored losslessly on Device B!
    const devBSummary = devB.app.stewardService.atlas.getPlaneSummary();
    const planesOnB = Object.keys(devBSummary.byPlane);
    expect(planesOnB.some((p) => p === "self_core")).toBe(true);
    expect(planesOnB.some((p) => p === "owner_life")).toBe(true);
    expect(planesOnB.some((p) => p.startsWith("relational:duo:"))).toBe(true);
    expect(planesOnB.some((p) => p.startsWith("domain_work:"))).toBe(true);
    expect(planesOnB.some((p) => p === "meta_evolution")).toBe(true);
    expect(devBSummary.membraneBridgeCount).toBeGreaterThanOrEqual(1);

    expect(devB.app.stewardService.atlas.getNode(nanshanNode!.id)?.plane).toBe(
      "domain_work:contract-guard",
    );
    expect(devB.app.stewardService.atlas.getNode("wf:p5-meta-workflow")?.plane).toBe(
      "meta_evolution",
    );

    const devBMind = devB.app.stewardService.mindLoop.getMindJournalSnapshot();
    expect(
      devBMind.entries.some(
        (e) => e.id === "self:hyp:p5-sync-test" && e.status === "crystallized",
      ),
    ).toBe(true);
  });
});
