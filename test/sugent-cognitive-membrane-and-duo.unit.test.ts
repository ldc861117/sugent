import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MembraneError,
  SymmetricPrivatePocketVault,
  assertZeroCanaryLeak,
  distillPartnerWeatherCapsule,
  distillRelationalHeuristicToSelfCore,
  projectDuoConsensusToOwnerAnchors,
  renderWeatherCapsuleForDuoPrompt,
} from "../src/sugent/cognitive-membrane.js";
import {
  DuoStewardCrystallizer,
  buildDuoStewardSystemPrompt,
} from "../src/sugent/duo-steward-crystallizer.js";
import { resolveSugentGatewayConfig } from "../src/sugent/gateway.js";
import { StereoscopicAtlas } from "../src/sugent/stereoscopic-atlas.js";
import type { LedgerSnapshot } from "../src/sugent/stewardship-ledger.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()!();
  }
});

describe("CognitiveMembrane (M1-M4) & Duo Streaming (Wave P4.4)", () => {
  it("M1: distills enum-only weather capsule with zero ledger text leakage and blocks 10 canary patterns", () => {
    const nowIso = "2026-11-28T10:00:00.000Z";
    const ledger: LedgerSnapshot = {
      version: 1,
      updatedAt: nowIso,
      relationships: [],
      goals: [
        {
          id: "g1",
          partition: "work_project",
          title: "SECRET_GOAL_ACQUISITION_280K",
          northStarCriterion: "Close ¥280000 deal at /Users/andy/private/plan.md",
          status: "active",
          targetDateIso: "2026-11-30T00:00:00.000Z",
          lastProgressAt: nowIso,
          stallThresholdDays: 7,
        },
      ],
      guardrails: [
        {
          id: "gr1",
          partition: "personal_life",
          kind: "hard_redline",
          statement: "CANARY_FLOOR_PRICE_NEVER_SHARE",
          enforcement: "block_and_alert",
          createdAt: nowIso,
        },
      ],
      commitments: [
        {
          id: "c1",
          partition: "work_project",
          direction: "i_owe",
          status: "open",
          summary: "CANARY_CLIENT_CONTRACT_XYZ",
          counterpartyOrRef: "SecretCounterpartyCorp",
          dueAt: "2026-11-29T12:00:00.000Z",
          updatedAt: nowIso,
        },
        {
          id: "c2",
          partition: "work_project",
          direction: "i_owe",
          status: "waiting_review",
          summary: "Deliver build",
          counterpartyOrRef: "PartnerAlpha",
          dueAt: "2026-11-29T18:00:00.000Z",
          updatedAt: nowIso,
        },
      ],
      resources: [],
    };

    const capsule = distillPartnerWeatherCapsule({
      spaceId: "andy-gillna",
      subject: "M",
      ledger,
      runningSessionCount: 2,
      quietHoursActive: true,
      recentDropCount: 3,
      nowIso,
    });

    expect(capsule.cognitiveLoad).toBe("overloaded");
    expect(capsule.restDeficit).toBe(true);
    expect(capsule.recoveryMode).toBe("quiet_compression");
    expect(capsule.busyWindowHint).toBe("deadline_sprint");
    expect(capsule.openCommitmentPressure).toBe("elevated");

    const serialized = JSON.stringify(capsule);
    expect(serialized).not.toContain("SECRET_GOAL");
    expect(serialized).not.toContain("CANARY_");
    expect(serialized).not.toContain("SecretCounterpartyCorp");
    expect(serialized).not.toContain("/Users/andy");

    const promptText = renderWeatherCapsuleForDuoPrompt(capsule, "Andy", [
      "CANARY_FLOOR_PRICE_NEVER_SHARE",
      "SecretCounterpartyCorp",
    ]);
    expect(promptText).toContain("Andy");
    expect(promptText).toContain("脱敏边界态");

    const tenCanaries = [
      "token sk-1234567890abcdef1234567890abcdef leaked",
      "Bearer ghp_1234567890abcdefghijklmnopqrstuvwxyz",
      "budget is ¥280000 for this",
      "price is $4500.50 total",
      "valuation around 35万",
      "transfer 1200 usdc tomorrow",
      "file at /Users/andy/Documents/secret.txt",
      "config in /home/ops/.env.prod",
      "path C:\\Users\\admin\\keys.json",
      "do not mention FloorPrice280K here",
    ];
    expect(tenCanaries).toHaveLength(10);
    for (const sample of tenCanaries) {
      expect(() => assertZeroCanaryLeak(sample, ["FloorPrice280K"])).toThrowError(MembraneError);
      try {
        assertZeroCanaryLeak(sample, ["FloorPrice280K"]);
      } catch (err) {
        expect((err as MembraneError).code).toBe("MEMBRANE_CANARY_LEAK");
      }
    }
  });

  it("M2: isolates M/W symmetric private pockets, supports AES-256-GCM passphrase encryption, and promotes safe candidates", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-membrane-m2-"));
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const duo = new DuoStewardCrystallizer({ dataDir: tmpDir });
    expect(duo.pockets).toBeInstanceOf(SymmetricPrivatePocketVault);

    const plainNote = duo.pockets.putPrivateNote({
      spaceId: "andy-gillna",
      actor: "W",
      topicHint: "evening-ritual",
      content: "希望周五晚饭后能一起散步二十分钟不看手机",
    });
    expect(plainNote.encrypted).toBe(false);
    expect(plainNote.content).toBe("希望周五晚饭后能一起散步二十分钟不看手机");

    const encNote = duo.pockets.putPrivateNote({
      spaceId: "andy-gillna",
      actor: "W",
      topicHint: "inner-anxiety",
      content: "最近工作太忙时容易患得患失",
      passphrase: "charon-orbit-pass-99",
    });
    expect(encNote.encrypted).toBe(true);
    expect(encNote.content).toBeUndefined();
    expect(encNote.ciphertextB64).toBeTruthy();

    // Cross-partner access denied
    expect(() =>
      duo.pockets.listPocketNotes({
        spaceId: "andy-gillna",
        viewer: "M",
        targetOwner: "W",
      }),
    ).toThrowError(MembraneError);
    try {
      duo.pockets.listPocketNotes({ spaceId: "andy-gillna", viewer: "M", targetOwner: "W" });
    } catch (err) {
      expect((err as MembraneError).code).toBe("MEMBRANE_PRINCIPAL_DENIED");
    }

    // Locked listing without passphrase or wrong passphrase returns "[encrypted]" safely
    const lockedList = duo.pockets.listPocketNotes({ spaceId: "andy-gillna", viewer: "W" });
    expect(lockedList.find((n) => n.id === encNote.id)?.content).toBe("[encrypted]");
    const wrongPassList = duo.pockets.listPocketNotes({
      spaceId: "andy-gillna",
      viewer: "W",
      passphrase: "wrong-passphrase",
    });
    expect(wrongPassList.find((n) => n.id === encNote.id)?.content).toBe("[encrypted]");

    // Matching passphrase decrypts cleanly
    const unlockedList = duo.pockets.listPocketNotes({
      spaceId: "andy-gillna",
      viewer: "W",
      passphrase: "charon-orbit-pass-99",
    });
    expect(unlockedList.find((n) => n.id === encNote.id)?.content).toBe("最近工作太忙时容易患得患失");

    // Rejects secret inside pocket
    expect(() =>
      duo.pockets.putPrivateNote({
        spaceId: "andy-gillna",
        actor: "M",
        content: "my key is sk-1234567890abcdef1234567890abcdef",
      }),
    ).toThrowError(MembraneError);

    // Promote safe candidate to Duo vault & reject canary leak during promotion
    expect(() =>
      duo.pockets.promoteNoteToSharedCandidate({
        spaceId: "andy-gillna",
        actor: "W",
        noteId: plainNote.id,
        title: "周五散步",
        summary: "预算 ¥5000 去散步",
        duo,
      }),
    ).toThrowError(MembraneError);

    const promoted = duo.pockets.promoteNoteToSharedCandidate({
      spaceId: "andy-gillna",
      actor: "W",
      noteId: plainNote.id,
      title: "周五晚间无手机散步仪式",
      summary: "周五晚饭后保留二十分钟散步窗口，把注意力留给彼此。",
      duo,
    });
    expect(promoted.crystal.kind).toBe("micro_card");
    expect(promoted.crystal.endorsedBy).toEqual(["W"]);
    expect(promoted.note.promotedCrystalId).toBe(promoted.crystal.id);
    const refreshedW = duo.pockets.listPocketNotes({ spaceId: "andy-gillna", viewer: "W" });
    expect(refreshedW.find((n) => n.id === plainNote.id)?.promotedCrystalId).toBe(promoted.crystal.id);
  });

  it("M3+M4: projects Duo consensus into owner_life anchors and distills de-identified heuristics into self_core", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-membrane-m34-"));
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const duo = new DuoStewardCrystallizer({ dataDir: tmpDir });
    const atlas = new StereoscopicAtlas(":memory:");
    cleanups.push(() => atlas.close());

    const crystal = duo.upsertCrystal({
      spaceId: "andy-gillna",
      topicKey: "friday-buffer",
      kind: "friction_antidote",
      title: "Andy 与 Gillna 2026-11-28 周五晚间减压仪式",
      summary: "Pluto 和 Charon 在高压工作周结束时容易沉默紧绷，2026年11月起约定先共进热汤再复盘。",
      triggerSignal: "周五晚间高压收尾后的沉默紧绷",
      gentleAction: "Andy 先给出十分钟安抚在场信号，再与 Gillna 于 20:30 散步共处",
      forceCrystallize: true,
    });
    const commitment = duo.upsertCommitment({
      spaceId: "andy-gillna",
      category: "quality_time",
      title: "周末早晨慢咖啡留白",
      detail: "周六上午 10:00 前不打开工作消息，专心共处聊天。",
      proposer: "both",
    });

    const vault = duo.getVaultSnapshot("andy-gillna");
    const anchors = projectDuoConsensusToOwnerAnchors({ vault, atlas });
    expect(anchors.length).toBe(2);
    const crystalAnchor = anchors.find((a) => a.id === crystal.id)!;
    expect(crystalAnchor.protectedWindowKeywords).toEqual(
      expect.arrayContaining(["周五", "晚间", "散步", "共处", "2026-11-28"]),
    );
    const commitAnchor = anchors.find((a) => a.id === commitment.id)!;
    expect(commitAnchor.protectedWindowKeywords).toEqual(
      expect.arrayContaining(["周末", "共处", "留白", "周六", "10:00"]),
    );

    const ownerRecall = atlas.recallStereoscopic("周五 晚间 散步", {
      planes: ["owner_life"],
      callerPrincipals: ["sugent_self", "owner:M"],
    });
    expect(ownerRecall.nodes.some((n) => n.id === `duo-anchor:andy-gillna:${crystal.id}`)).toBe(true);
    expect(ownerRecall.nodes.every((n) => n.stratum !== "raw_episodic")).toBe(true);

    const bridgeRecall = atlas.recallStereoscopic("周五 晚间 散步", {
      callerPrincipals: ["sugent_self", "owner:M", "partner:W"],
    });
    expect(bridgeRecall.crossPlaneBridges.some((e) => e.membranePolicy === "M3_consensus_anchor")).toBe(true);

    const heuristics = distillRelationalHeuristicToSelfCore({
      vault,
      partnerLabels: { M: "Andy", W: "Gillna" },
      atlas,
    });
    expect(heuristics).toHaveLength(1);
    expect(heuristics[0]!.id).toMatch(/^self:heuristic:[a-f0-9]{12}$/);
    expect(heuristics[0]!.heuristic).not.toMatch(/Andy|Gillna|Pluto|Charon|2026/);

    const selfRecall = atlas.recallStereoscopic("沉默 紧绷 调频", {
      planes: ["self_core"],
      callerPrincipals: ["sugent_self", "owner:M"],
    });
    expect(selfRecall.nodes.some((n) => n.id === heuristics[0]!.id && n.stratum === "digested_state")).toBe(true);

    const m4BridgeRecall = atlas.recallStereoscopic("沉默 紧绷 调频", {
      callerPrincipals: ["sugent_self", "owner:M", "partner:W"],
    });
    expect(m4BridgeRecall.crossPlaneBridges.some((e) => e.membranePolicy === "M4_deidentified_wisdom")).toBe(true);
  });

  it("streams Duo Steward SSE deltas cleanly and falls back in chunks offline", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-duo-stream-"));
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const sysPrompt = buildDuoStewardSystemPrompt({
      speaker: "M",
      activeCrystals: [],
      activeCommitments: [],
      weatherCapsuleContext: "=== 伴侣近期星轨天气胶囊（脱敏边界态） ===\nGillna 状态从容",
      siliconCharterBlock: "【硅基个体宪章】诚实且温和",
    });
    expect(sysPrompt).toContain("硅基个体");
    expect(sysPrompt).toContain("伴侣近期星轨天气胶囊");
    expect(sysPrompt).toContain("【硅基个体宪章】诚实且温和");

    const encoder = new TextEncoder();
    const sseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"model":"gpt-5.4","choices":[{"delta":{"content":"星轨"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"轻柔"}}]}\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"同频。"}}]}\n\ndata: [DONE]\n\n'));
        controller.close();
      },
    });
    const sseFetch: typeof fetch = async () =>
      new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } });

    const gwCfg = resolveSugentGatewayConfig(undefined, {
      SUGENT_GATEWAY_URL: "http://127.0.0.1:18888/v1",
      SUGENT_GATEWAY_KEY: "test-gateway-token-safe",
      SUGENT_MODEL_EXECUTOR: "openai/gpt-5.4",
    });
    const duoStream = new DuoStewardCrystallizer({
      dataDir: tmpDir,
      getGatewayConfig: () => gwCfg,
      fetchImpl: sseFetch,
    });

    const deltas: string[] = [];
    const sseRes = await duoStream.streamConverseAsDuoSteward({
      spaceId: "andy-gillna",
      speaker: "M",
      messages: [{ role: "user", content: "今晚想聊聊这周的相处节奏" }],
      weatherCapsuleContext: "=== 伴侣近期星轨天气胶囊（脱敏边界态） ===\nGillna 状态从容",
      siliconCharterBlock: "【硅基个体宪章】诚实且温和",
      onDelta: (d) => deltas.push(d),
    });
    expect(sseRes.ok).toBe(true);
    expect(sseRes.streamed).toBe(true);
    expect(sseRes.modelUsed).toBe("gpt-5.4");
    expect(sseRes.reply).toBe("星轨轻柔同频。");
    expect(deltas).toEqual(["星轨", "轻柔", "同频。"]);

    const duoOffline = new DuoStewardCrystallizer({ dataDir: tmpDir });
    const offlineDeltas: string[] = [];
    const offlineRes = await duoOffline.streamConverseAsDuoSteward({
      spaceId: "andy-gillna",
      speaker: "W",
      messages: [{ role: "user", content: "离线时也能陪我梳理吗" }],
      onDelta: (d) => offlineDeltas.push(d),
    });
    expect(offlineRes.ok).toBe(true);
    expect(offlineRes.streamed).toBe(false);
    expect(offlineRes.modelUsed).toBe("sugent-offline-steward");
    expect(offlineDeltas.length).toBeGreaterThanOrEqual(2);
    expect(offlineDeltas.join("")).toBe(offlineRes.reply);
  });
});
