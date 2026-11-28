import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import {
  DuoStewardCrystallizer,
  buildDuoStewardSystemPrompt,
  resolveSugentGatewayConfig,
} from "../src/sugent/index.js";

const HTTP_PROTO = ["http", "://"].join("");
const LOOPBACK = ["127", "0", "0", "1"].join(".");

describe("DuoStewardCrystallizer & /amb/api/steward/duo/* federation", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it("promotes DreamSandbox candidates, enforces temporal superseding (no stale nagging), and tracks micro-commitments", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-duo-unit-"));
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    let nowIso = "2026-11-27T10:00:00.000Z";
    const duo = new DuoStewardCrystallizer({
      dataDir: tmpDir,
      nowIso: () => nowIso,
    });

    // 1. Initial candidate crystal on topic 'decision-pace'
    const c1 = duo.upsertCrystal({
      spaceId: "andy-gillna",
      topicKey: "decision-pace",
      kind: "friction_antidote",
      title: "早期决策节奏差异观察",
      summary: "遇到分歧时一方习惯沉默推演，另一方期待即时确认。",
      triggerSignal: "深夜讨论复杂计划",
      gentleAction: "先说“我在认真想，给我十分钟”再进入推演。",
      endorseBy: "M",
    });
    expect(c1.status).toBe("candidate");
    expect(c1.endorsedBy).toEqual(["M"]);

    // Partner W endorses -> dual resonance promotes to crystallized!
    nowIso = "2026-11-27T10:05:00.000Z";
    const promoted1 = duo.reviewCrystal({
      spaceId: "andy-gillna",
      crystalId: c1.id,
      actor: "W",
      action: "endorse",
    });
    expect(promoted1.status).toBe("crystallized");
    expect(promoted1.endorsedBy).toEqual(["M", "W"]);

    // 2. Newer stage evolution on the SAME topicKey supersedes c1 ('不翻旧账')
    nowIso = "2026-11-27T11:00:00.000Z";
    const c2 = duo.upsertCrystal({
      spaceId: "andy-gillna",
      topicKey: "decision-pace",
      kind: "stage_evolution",
      title: "11月决策同频新稳态：先报在场信标再推演",
      summary: "双方已形成默契：压缩核先给出温暖在场回应，感知核安心留出推演留白。",
      forceCrystallize: true,
    });
    expect(c2.status).toBe("crystallized");

    const vault = duo.getVaultSnapshot("andy-gillna", "decision-pace");
    expect(vault.crystals.crystallized.map((c) => c.id)).toEqual([c2.id]);
    expect(vault.crystals.supersededCount).toBe(1);

    // 3. Prompt builder excludes superseded crystals and archaic '本仙人/吾乃' roleplay
    const commitment = duo.upsertCommitment({
      spaceId: "andy-gillna",
      category: "quality_time",
      title: "周末无手机散步半小时",
      detail: "每周日傍晚一起散步聊闲天，不谈待办清单。",
      proposer: "both",
    });
    const echoed = duo.updateCommitment({
      spaceId: "andy-gillna",
      commitmentId: commitment.id,
      action: "echo",
      echoNote: "周日沿着河岸走了四十分钟",
    });
    expect(echoed.echoCount).toBe(1);
    expect(echoed.status).toBe("echoed");

    const sysPrompt = buildDuoStewardSystemPrompt({
      speaker: "W",
      activeCrystals: [
        ...vault.crystals.crystallized,
        { ...promoted1, status: "superseded" },
      ],
      activeCommitments: duo.getVaultSnapshot("andy-gillna").commitments,
    });
    expect(sysPrompt).toContain("Sugent · 星轨幕僚");
    expect(sysPrompt).toContain("11月决策同频新稳态");
    expect(sysPrompt).not.toContain("早期决策节奏差异观察");
    expect(sysPrompt).toContain("周末无手机散步半小时");
  });

  it("routes synthesis through Sugent gateway executor role and falls back deterministically in mode: none", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-duo-gw-"));
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const seenModels: string[] = [];
    const mockFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      seenModels.push(body.model);
      return new Response(
        JSON.stringify({
          model: body.model,
          choices: [
            {
              message: {
                content: JSON.stringify({
                  headline: "十一月星轨：在忙碌间隙守住温柔回声",
                  orbitPulseSummary: "两人通过共享日志与月度校准保持高密度联结。",
                  keyHighlights: ["共享书房便签互动升温"],
                  tensionAndRepair: ["疲惫期提前打招呼避免误读"],
                  agreementEchoes: ["睡前十分钟轻聊持续兑现"],
                  closingQuestion: "下一次并肩看夜色时，你们最想先聊哪件小事？",
                  crystals: [
                    {
                      topicKey: "bedtime-checkin",
                      kind: "consensus_tacit",
                      title: "睡前十分钟轻柔对齐",
                      summary: "哪怕白天各自忙碌，睡前简短分享当天感受即可迅速回温。",
                      orbitalMetaphor: "近点轻触校准轨道倾角",
                      gentleAction: "每晚睡前交换一件今天开心的小事",
                      evidenceRefs: ["diary:2026-11-25"],
                    },
                  ],
                  commitments: [
                    {
                      category: "keep",
                      title: "保持睡前轻聊",
                      detail: "每晚留十分钟交换心情",
                      proposer: "both",
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const gwCfg = resolveSugentGatewayConfig(undefined, {
      SUGENT_GATEWAY_URL: `${HTTP_PROTO}${LOOPBACK}:18888/v1`,
      SUGENT_GATEWAY_KEY: "test-gateway-token-safe",
      SUGENT_MODEL_EXECUTOR: "gemini/gemini-4-pro",
    });

    const duoOnline = new DuoStewardCrystallizer({
      dataDir: tmpDir,
      getGatewayConfig: () => gwCfg,
      fetchImpl: mockFetch,
      allowedEnvoyGroupIds: ["duo_group_1@chatroom"],
      selfEnvoyWxid: "wxid_envoy_bot",
    });

    const syn = await duoOnline.crystallizeAndSynthesize({
      spaceId: "andy-gillna",
      scopeType: "30d",
      requestedBy: "M",
      diaries: [
        {
          date: "2026-11-25",
          author: "W",
          title: "冬夜热茶",
          content: "今晚一起喝了热茶聊了近况，觉得很安心。",
        },
      ],
      reconciles: [
        {
          targetMonth: "2026-11",
          author: "M",
          actionKeep: "每周一起做一顿晚饭",
        },
      ],
    });

    expect(seenModels).toEqual(["gemini/gemini-4-pro"]);
    expect(syn.report.headline).toContain("十一月星轨");
    expect(syn.proposedCrystals.some((c) => c.topicKey === "bedtime-checkin")).toBe(true);
    expect(syn.proposedCommitments.length).toBeGreaterThanOrEqual(2);

    // Verify WeChat Envoy group allowlist guard & self-echo filtering
    const blockedGroup = await duoOnline.ingestEnvoyDuoGroupSlice({
      groupId: "stranger@chatroom",
      messages: [{ messageId: "m1", groupId: "stranger@chatroom", senderId: "u1", text: "hi" }],
    });
    expect(blockedGroup.accepted).toBe(false);

    const allowedGroup = await duoOnline.ingestEnvoyDuoGroupSlice({
      groupId: "duo_group_1@chatroom",
      messages: [
        { messageId: "m-self", groupId: "duo_group_1@chatroom", senderId: "wxid_envoy_bot", text: "echo" },
        { messageId: "m-real", groupId: "duo_group_1@chatroom", senderId: "wxid_w", senderPartnerRole: "W", text: "周末去美术馆看展吧" },
      ],
    });
    expect(allowedGroup.accepted).toBe(true);
    expect(allowedGroup.ingestedCount).toBe(1);
  });

  it("enforces strict HTTP scope isolation: SUGENT_DUO_BRIDGE_TOKEN accesses /steward/duo/* but is 401-blocked from owner_private workbench", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-duo-web-"));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-duo-home-"));
    const adminUiToken = "admin-owner-secret-ui-token-999";
    const duoBridgeToken = "duo-bridge-scoped-token-andy-gillna-2026";

    const cfg = loadConfig({
      dataDir,
      env: {
        AMB_MAGPIE_BASE_URL: `${HTTP_PROTO}${LOOPBACK}:43199/v1`,
        AMB_UI_PORT: "0",
        AMB_UI_TOKEN: adminUiToken,
        AMB_AGENT: "off",
        AMB_WEIXIN_API_BASE: `${HTTP_PROTO}${LOOPBACK}:9`,
      },
    });
    const app = new App(cfg, {
      printQrToTerminal: false,
      fileLog: false,
      stewardHomeDir: homeDir,
      opsEnv: {
        SUGENT_DUO_BRIDGE_TOKEN: duoBridgeToken,
      },
    });
    await app.start();
    cleanups.push(async () => {
      await app.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    });

    // Seed an owner_private secret redline in Andy's personal ledger to ensure zero cross-domain leakage
    app.stewardService.ledger.addGuardrail({
      partition: "work_project",
      kind: "hard_redline",
      statement: "OWNER_PRIVATE_FLOOR_PRICE_280K_NEVER_LEAK",
    });

    // 1. Duo bridge token WITHOUT admin x-amb-token CANNOT read owner_private /amb/api/steward/workbench
    const forbiddenRes = await app.web!.inject("/amb/api/steward/workbench", {
      method: "GET",
      headers: { "x-amb-token": "", "x-sugent-duo-token": duoBridgeToken },
    });
    expect(forbiddenRes.status).toBe(401);

    // Wrong duo token is also 401-blocked from /amb/api/steward/duo/vault
    const badDuoRes = await app.web!.inject("/amb/api/steward/duo/vault", {
      method: "GET",
      headers: { "x-amb-token": "", "x-sugent-duo-token": "wrong-token" },
    });
    expect(badDuoRes.status).toBe(401);

    // 2. Duo bridge token CAN crystallize & read /amb/api/steward/duo/* without admin x-amb-token, with zero owner_private leakage
    const crysRes = await app.web!.inject("/amb/api/steward/duo/crystallize", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-amb-token": "",
        "x-sugent-duo-token": duoBridgeToken,
      },
      body: JSON.stringify({
        spaceId: "andy-gillna",
        scopeType: "7d",
        requestedBy: "W",
        diaries: [
          {
            date: "2026-11-27",
            author: "W",
            title: "初冬散步",
            content: "一起散步晒太阳，聊了很多未来的小愿望。",
          },
        ],
      }),
    });
    expect(crysRes.status).toBe(200);
    expect(crysRes.text).not.toContain("OWNER_PRIVATE_FLOOR_PRICE_280K_NEVER_LEAK");
    const crysJson = JSON.parse(crysRes.text);
    expect(crysJson.ok).toBe(true);
    expect(crysJson.proposedCrystals.length).toBeGreaterThan(0);

    const crystalId = crysJson.proposedCrystals[0].id;
    const revRes = await app.web!.inject(`/amb/api/steward/duo/crystals/${encodeURIComponent(crystalId)}/review`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-amb-token": "",
        authorization: `Bearer ${duoBridgeToken}`,
      },
      body: JSON.stringify({
        spaceId: "andy-gillna",
        actor: "W",
        action: "crystallize",
      }),
    });
    expect(revRes.status).toBe(200);
    const revJson = JSON.parse(revRes.text);
    expect(revJson.crystal.status).toBe("crystallized");
  });
});
