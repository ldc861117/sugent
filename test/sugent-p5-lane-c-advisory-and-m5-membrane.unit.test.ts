import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InboundEvent } from "../src/core/types.js";
import {
  MembraneError,
  distillConciergeEnvoyCapsule,
  guardConciergeOutboundText,
  renderConciergeEnvoyPromptBlock,
} from "../src/sugent/cognitive-membrane.js";
import { ConciergeChannelBridge } from "../src/sugent/concierge-channel-bridge.js";
import { resolveSugentGatewayConfig } from "../src/sugent/gateway.js";
import { SugentKnowledgeGraph } from "../src/sugent/knowledge-graph.js";
import { EpistemicDigestionLoop } from "../src/sugent/silicon-identity-core.js";
import { StereoscopicAtlas, type GraphPlaneId } from "../src/sugent/stereoscopic-atlas.js";
import { StewardshipLedger } from "../src/sugent/stewardship-ledger.js";
import { UniversalDropzone } from "../src/sugent/universal-dropzone.js";
import {
  buildThreeSecondForwardedBriefing,
  ingestForwardedBriefingToLedger,
} from "../src/sugent/weixin-quota-and-briefing.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()!();
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("Wave P5.3 (Lane C) — Stereoscopic Advisory, 3s Briefing Atlas Link & M5 Concierge Membrane", () => {
  it("1. UniversalDropzone.handleAdvise & handleDelegate hit domain_work, self_core tombstones, and relational:peer taboos for owner_private while isolating work_project", async () => {
    const tmpDir = makeTempDir("sugent-p5c-dropzone-");
    const ledger = new StewardshipLedger({ dataDir: tmpDir });
    ledger.upsertGoal({
      id: "goal-p5-margin",
      partition: "work_project",
      title: "守住 Q4 交付现金流健康度",
      northStarCriterion: "新签项目首付 >= 30% 且净账期 <= 45 天",
    });

    const atlas = new StereoscopicAtlas(":memory:");
    cleanups.push(() => atlas.close());

    atlas.applyDelta({
      nodes: [
        {
          id: "contract:review:inq-hd-01",
          plane: "domain_work:contract-guard",
          stratum: "crystallized_wisdom",
          kind: "tombstone",
          name: "合同审校 华东重工 (block)",
          summary: "触发护栏: 单价底线 60 万人民币，账期上限 30 天；账期超限 90天",
          tags: ["weapon_pack", "contract_guard", "block"],
          principalAcl: ["sugent_self", "owner:M"],
          sourceTrust: "deterministic_gate",
        },
        {
          id: "self:tombstone:net90-concession",
          plane: "self_core",
          stratum: "crystallized_wisdom",
          kind: "tombstone",
          name: "教训墓碑: 华东长账期让步",
          summary: "避坑教训 [net90-concession]：原判断「给大客户放宽 90 天账期换二期签单」已被证伪（尾款拖欠半年）",
          tags: ["epistemic_tombstone", "账期"],
          principalAcl: ["sugent_self", "owner:M"],
          sourceTrust: "owner_confirmed",
        },
        {
          id: "peer:huadong-zhou",
          plane: "relational:peer:huadong",
          stratum: "verified_fact",
          kind: "person",
          name: "周总",
          summary: "忌讳:切忌提及友商X停线事故/别催太急；偏好:先给里程碑排期",
          tags: ["peer:huadong"],
          principalAcl: ["sugent_self", "owner:M"],
          sourceTrust: "owner_confirmed",
        },
        {
          id: "duo-anchor:friday-family-walk",
          plane: "owner_life",
          stratum: "verified_fact",
          kind: "guardrail",
          name: "周五晚间伴侣散步留白",
          summary: "OWNER_LIFE_SECRET_WALK_2030 周五晚间绝不排商务电话或评审",
          tags: ["duo_anchor", "周五"],
          principalAcl: ["sugent_self", "owner:M"],
          sourceTrust: "mutual_endorsed",
        },
      ],
    });

    const gatewayConfig = resolveSugentGatewayConfig(undefined, {
      SUGENT_GATEWAY_MODE: "byok",
      SUGENT_MODEL_STEWARD: "model/steward-p5",
      SUGENT_MODEL_EXECUTOR: "model/executor-p5",
    });

    const capturedSummaries: string[] = [];
    const atlasRecallSpy = vi.fn((query: string, opts?: { planes?: string[]; maxNodes?: number }) => {
      const prefixes = opts?.planes ?? [];
      const allPlanes = Array.from(new Set(atlas.allNodes().map((n) => n.plane)));
      const matchedPlanes =
        prefixes.length > 0
          ? (allPlanes.filter((pl) => prefixes.some((pf) => pl === pf || pl.startsWith(`${pf}:`))) as GraphPlaneId[])
          : undefined;
      return {
        nodes: atlas.recallStereoscopic(query, {
          ...(matchedPlanes ? { planes: matchedPlanes } : {}),
          maxNodes: opts?.maxNodes ?? 12,
          callerPrincipals: ["sugent_self", "owner:M"],
        }).nodes,
      };
    });

    const dropzone = new UniversalDropzone({
      ledger,
      atlasRecall: atlasRecallSpy,
      gatewayConfig,
      adviseGenerator: async ({ contextSummary }) => {
        capturedSummaries.push(contextSummary);
        return `参谋结论：\n${contextSummary}`;
      },
    });

    // (a) owner_private advise hits 100% (3/3): domain_work:contract-guard + self_core tombstone + relational:peer taboo
    const ownerAdvise = await dropzone.handle({
      inputId: "p5-adv-owner",
      channel: "weixin",
      callerDomain: "owner_private",
      text: "华东重工周总这次要求走 90 天账期并压低报价，怎么回？",
      receivedAtIso: "2026-11-28T10:00:00.000Z",
    });
    expect(ownerAdvise.intent).toBe("advise");
    if (ownerAdvise.intent !== "advise") throw new Error("expected advise");
    expect(atlasRecallSpy).toHaveBeenCalledWith(
      "华东重工周总这次要求走 90 天账期并压低报价，怎么回？",
      { planes: ["domain_work", "self_core", "relational:peer", "owner_life"], maxNodes: 12 },
    );
    expect(ownerAdvise.guardrailWarnings.some((w) => w.includes("[历史审校预警]") && w.includes("华东重工"))).toBe(true);
    expect(ownerAdvise.guardrailWarnings.some((w) => w.includes("[图谱墓碑预警]") && w.includes("尾款拖欠半年"))).toBe(true);
    expect(ownerAdvise.guardrailWarnings.some((w) => w.includes("[人脉禁忌提醒:周总]") && w.includes("友商X停线事故"))).toBe(true);
    expect(ownerAdvise.tradeOffBrief).toContain("历史图谱参考：");
    expect(capturedSummaries[0]).toContain("[self_core]");
    expect(capturedSummaries[0]).toContain("[domain_work:contract-guard]");

    // (b) work_project advise strictly restricts to domain_work* and NEVER exposes owner_life or self_core (even with 1-arg callback!)
    const oneArgDropzone = new UniversalDropzone({
      ledger,
      // 1-arg backward-compatible callback returning unfiltered nodes across all planes
      atlasRecall: (q) => ({
        nodes: atlas.recallStereoscopic(q, { callerPrincipals: ["sugent_self", "owner:M"], maxNodes: 12 }).nodes,
      }),
      gatewayConfig,
    });

    const workAdvise = await oneArgDropzone.handle({
      inputId: "p5-adv-work",
      channel: "feishu",
      callerDomain: "work_project",
      text: "周五晚间华东重工要求 90 天账期评审，怎么选？",
      receivedAtIso: "2026-11-28T10:05:00.000Z",
    });
    expect(workAdvise.intent).toBe("advise");
    if (workAdvise.intent !== "advise") throw new Error("expected advise");
    expect(workAdvise.guardrailWarnings.some((w) => w.includes("华东重工"))).toBe(true);
    expect(JSON.stringify(workAdvise)).not.toContain("OWNER_LIFE_SECRET_WALK_2030");
    expect(JSON.stringify(workAdvise)).not.toContain("伴侣散步留白");
    expect(JSON.stringify(workAdvise)).not.toContain("尾款拖欠半年");
    expect(JSON.stringify(workAdvise)).not.toContain("友商X停线事故");

    // (c) owner_private handleDelegate (human_prep_bundle) sanitizes peer taboos from relational:peer and adds tombstone checklist item
    atlas.applyDelta({
      nodes: [
        {
          id: "peer:property-mgr",
          plane: "relational:peer:property",
          stratum: "verified_fact",
          kind: "person",
          name: "物业刘主任",
          summary: "忌讳:切忌提及拒交物业费；偏好:先约上门时段",
          principalAcl: ["sugent_self", "owner:M"],
        },
        {
          id: "self:tombstone: verbal-repair",
          plane: "self_core",
          stratum: "crystallized_wisdom",
          kind: "tombstone",
          name: "教训墓碑: 物业报修未留书面确认",
          summary: "避坑教训：物业漏水口头报修未留照片导致责任扯皮已被证伪",
          tags: ["epistemic_tombstone", "物业", "漏水"],
          principalAcl: ["sugent_self", "owner:M"],
        },
      ],
    });

    const prepOut = await dropzone.handle({
      inputId: "p5-del-prep",
      channel: "weixin",
      callerDomain: "owner_private",
      text: "帮我联系物业刘主任修一下阳台漏水（别提拒交物业费）",
      receivedAtIso: "2026-11-28T11:00:00.000Z",
    });
    expect(prepOut.intent).toBe("delegate");
    if (prepOut.intent !== "delegate" || prepOut.mode !== "human_prep_bundle") {
      throw new Error("expected human_prep_bundle");
    }
    expect(prepOut.bundle.readyToCopyDrafts[0]!.text).toContain("物业刘主任");
    expect(prepOut.bundle.readyToCopyDrafts[0]!.text).not.toContain("拒交物业费");
    expect(prepOut.bundle.checklist.length).toBeLessThanOrEqual(5);
    expect(prepOut.bundle.checklist.some((item) => item.includes("历史避坑核对") && item.includes("物业报修未留书面确认"))).toBe(
      true,
    );
  });

  it("2. buildThreeSecondForwardedBriefing & ingestForwardedBriefingToLedger recall domain_work:contract-guard + self_core tombstones even when StewardshipLedger is empty", () => {
    const tmpDir = makeTempDir("sugent-p5c-fwd-");
    // Empty ledger: zero guardrails, zero resources, zero relationships for the new counterparty!
    const emptyLedger = new StewardshipLedger({ dataDir: tmpDir });
    const atlas = new StereoscopicAtlas(":memory:");
    cleanups.push(() => atlas.close());

    atlas.applyDelta({
      nodes: [
        {
          id: "contract:review:yh-block-01",
          plane: "domain_work:contract-guard",
          stratum: "crystallized_wisdom",
          kind: "tombstone",
          name: "合同审校 远航船务赵总 (block)",
          summary: "触发护栏: 远航船务单价底线 28 万元，账期上限 45 天；账期超限 90天",
          tags: ["weapon_pack", "contract_guard", "block"],
          principalAcl: ["sugent_self", "owner:M"],
          sourceTrust: "deterministic_gate",
        },
        {
          id: "self:tombstone:zero-downpayment-trap",
          plane: "self_core",
          stratum: "crystallized_wisdom",
          kind: "tombstone",
          name: "教训墓碑: 零首付驻场陷阱",
          summary: "避坑教训 [zero-downpayment]：原判断「零首付先入场可快速锁单」已被证伪（客户反复变更范围拒付首款）",
          tags: ["epistemic_tombstone", "零首付", "商务"],
          principalAcl: ["sugent_self", "owner:M"],
          sourceTrust: "owner_confirmed",
        },
        {
          id: "peer:yh-zhao",
          plane: "relational:peer:yh-zhao",
          stratum: "verified_fact",
          kind: "person",
          name: "远航船务赵总",
          summary: "忌讳:切忌提及船坞延期罚款/不要承诺驻场包干；偏好:正式克制敬语",
          tags: ["peer:yh-zhao"],
          principalAcl: ["sugent_self", "owner:M"],
        },
      ],
    });

    const forwardedText = [
      "[合并转发的聊天记录]",
      "我: 赵总，产线诊断一期方案已发您审阅",
      "远航船务赵总: 方案收到了，总价能不能便宜到 19 万？另外我们要走验收后账期 90 天，零首付先驻场包干两周。",
      "我: 明天上午前我核对核算底线后给您答复。",
    ].join("\n");

    const briefing = buildThreeSecondForwardedBriefing({
      workspaceDir: path.join(tmpDir, "ws"),
      ledger: emptyLedger,
      atlas,
      rawForwardedText: forwardedText,
      ownerName: "我",
    });

    expect(briefing.counterparty).toBe("远航船务赵总");
    expect(briefing.historicalFloorAnchors.some((a) => a.includes("[domain_work]") && a.includes("28 万元"))).toBe(true);
    expect(briefing.triggeredRedlines.some((r) => r.includes("报价破底价红线") && r.includes("19 万 < 历史底价 28 万"))).toBe(
      true,
    );
    expect(briefing.triggeredRedlines.some((r) => r.includes("账期超限红线") && r.includes("90 天 > 历史上限 45 天"))).toBe(
      true,
    );
    expect(briefing.triggeredRedlines.some((r) => r.includes("历史合同审校红线") && r.includes("contract-guard") === false)).toBe(
      true,
    );
    expect(briefing.triggeredRedlines.some((r) => r.includes("[硅基墓碑预警]") && r.includes("零首付驻场陷阱"))).toBe(true);
    expect(briefing.recalledTaboos).toContain("切忌提及船坞延期罚款");
    expect(briefing.recalledTaboos).toContain("不要承诺驻场包干");
    expect(briefing.triggeredRedlines.some((r) => r.includes("触碰客户沟通禁忌：不要承诺驻场包干"))).toBe(true);
    expect(briefing.recalledAtlasRefs).toEqual(
      expect.arrayContaining([
        "contract:review:yh-block-01",
        "self:tombstone:zero-downpayment-trap",
        "peer:yh-zhao",
      ]),
    );
    expect(briefing.copyableDrafts.firmBoundary).toContain("28 万");
    expect(briefing.copyableDrafts.firmBoundary).toContain("45 天内");
    expect(briefing.copyableDrafts.firmBoundary).not.toContain("船坞延期罚款");
    expect(briefing.copyableDrafts.collaborativeTradeoff).not.toContain("船坞延期罚款");

    const ingested = ingestForwardedBriefingToLedger({
      workspaceDir: path.join(tmpDir, "ws-ingest"),
      ledger: emptyLedger,
      atlas,
      rawForwardedText: forwardedText,
      ownerName: "我",
      nowIso: "2026-11-28T12:00:00.000Z",
    });
    expect(ingested.deduplicated).toBe(false);
    expect(ingested.briefing.recalledAtlasRefs).toContain("contract:review:yh-block-01");
    expect(ingested.briefing.triggeredRedlines.some((r) => r.includes("[硅基墓碑预警]"))).toBe(true);
    expect(ingested.recordedCommitments.length).toBeGreaterThanOrEqual(1);
  });

  it("3. Membrane M5 (concierge_envoy) injects de-identified LanguageProfiler style hints + concierge_envoy-only lessons with 0.0% canary leak across 15 canaries", async () => {
    const tmpDir = makeTempDir("sugent-p5c-m5-");
    const kg = new SugentKnowledgeGraph(tmpDir);
    const ledger = new StewardshipLedger({ dataDir: tmpDir, knowledgeGraph: kg });
    const atlas = new StereoscopicAtlas(":memory:");
    cleanups.push(() => atlas.close());
    const mindLoop = new EpistemicDigestionLoop({
      stewardDir: path.join(tmpDir, "steward"),
      atlas,
      nowIso: () => "2026-11-28T15:00:00.000Z",
    });

    // Seed owner_life, floor-price, private commitment, cross-peer, and current-peer poisoned hints
    ledger.upsertGoal({
      id: "g-family",
      partition: "personal_life",
      title: "CANARY_GOAL_FAMILY_CHECKUP_01",
      northStarCriterion: "每周五晚 20:00 陪家人散步不接外单 (/Users/andy/private/family-plan.md)",
    });
    ledger.addGuardrail({
      id: "gr-floor",
      partition: "work_project",
      kind: "hard_redline",
      statement: "CANARY_FLOOR_REDLINE_58W 对外顾问底价绝不低于 58 万元",
    });
    ledger.upsertResource({
      id: "res-private-nda",
      partition: "personal_life",
      kind: "personal_archive",
      title: "CANARY_ARCHIVE_MEDICAL_03",
      localUriOrPath: "/Users/andy/Documents/secret-medical-record.pdf",
      metadata: {
        floorPriceWan: 36,
        secretCanary: "CANARY_META_FLOOR_36W_04",
      },
    });
    ledger.upsertCommitment({
      id: "cmt-private-tax",
      partition: "personal_life",
      direction: "i_owe",
      summary: "CANARY_COMMIT_PRIVATE_TAX_05",
      counterpartyOrRef: "私人税务师陈姐",
    });
    ledger.upsertRelationship({
      id: "wx_other_client",
      partition: "work_project",
      name: "蓝鲸防务院",
      roleTag: "绝密政企客户",
      taboos: ["CANARY_CROSS_PEER_NDA_06"],
      preferences: [],
    });
    ledger.upsertRelationship({
      id: "wx_vip_envoy",
      partition: "work_project",
      name: "张总监",
      roleTag: "制造数字化负责人",
      preferences: [
        "偏好短句直给结论（不超过3行）",
        "沟通保持正式克制敬语",
        "先给可约排期时段",
        "内部备注底价 ¥280000 CANARY_POISONED_PREF_07 /home/ops/.env.secret",
      ],
      taboos: [
        "别催太急",
        "切忌暴露 CANARY_POISONED_TABOO_08 与 36万 底价",
      ],
    });

    atlas.applyDelta({
      nodes: [
        {
          id: "duo-anchor:friday-dinner",
          plane: "owner_life",
          stratum: "verified_fact",
          kind: "commitment",
          name: "CANARY_DUO_FRIDAY_DINNER_09",
          summary: "周五晚与伴侣共进晚餐留白窗",
          principalAcl: ["sugent_self", "owner:M"],
        },
        {
          id: "peer:wx_vip_envoy",
          plane: "relational:peer:wx_vip_envoy",
          stratum: "verified_fact",
          kind: "person",
          name: "张总监",
          summary: "忌讳:忌啰嗦长篇铺垫；偏好:倾向书面纪要确认",
          principalAcl: ["sugent_self", "owner:M", "peer:wx_vip_envoy"],
        },
      ],
    });

    // Seed lessons across multiple surfaces: ONLY concierge_envoy must pass M5!
    const imEntry = mindLoop.recordJudgment({
      topicKey: "owner-sleep-habit",
      surface: "im_owner",
      hypothesis: "CANARY_IM_OWNER_LESSON_10 夜间十点后主理人进入深度休息不谈公事",
    });
    mindLoop.reconcileOutcome({ idOrTopic: imEntry.id, outcome: "confirmed", ownerEndorsed: true });

    const duoEntry = mindLoop.recordJudgment({
      topicKey: "duo-friday-calm",
      surface: "duo_mediator",
      hypothesis: "CANARY_DUO_MEDIATOR_LESSON_11 高压周周五先共情安抚",
    });
    mindLoop.reconcileOutcome({ idOrTopic: duoEntry.id, outcome: "confirmed", ownerEndorsed: true });

    const codeEntry = mindLoop.recordJudgment({
      topicKey: "coding-gate",
      surface: "coding_orchestrator",
      hypothesis: "CANARY_CODING_LESSON_12 合并前必跑隔离沙盒验证",
    });
    mindLoop.reconcileOutcome({ idOrTopic: codeEntry.id, outcome: "confirmed", ownerEndorsed: true });

    // Poisoned concierge_envoy lesson with currency amount (must be dropped by M5!)
    const poisonedEnvoy = mindLoop.recordJudgment({
      topicKey: "envoy-bad-quote",
      surface: "concierge_envoy",
      hypothesis: "对外沟通报出 28万元 预算差点泄密",
    });
    mindLoop.reconcileOutcome({ idOrTopic: poisonedEnvoy.id, outcome: "falsified", ownerEndorsed: true });

    // Clean concierge_envoy lesson (MUST be included!)
    const cleanEnvoy = mindLoop.recordJudgment({
      topicKey: "envoy-slot-clarity",
      surface: "concierge_envoy",
      hypothesis: "对外预约回复优先提供两个明确备选时段并亮明数字助理身份",
    });
    mindLoop.reconcileOutcome({ idOrTopic: cleanEnvoy.id, outcome: "confirmed", ownerEndorsed: true });

    const bridge = new ConciergeChannelBridge({
      dataDir: tmpDir,
      knowledgeGraph: kg,
      ledger,
      mindLoop,
      atlas,
      resolveActorRole: ({ senderId }) => (senderId === "wx_owner" ? "owner" : "external_peer"),
      defaultTransport: {
        notifyOwner: async () => {},
        sendPeerDirectMessage: async () => {},
      },
    });

    const ownerCanaries = bridge.collectOwnerPrivateCanaryTokens("wx_vip_envoy");
    const fifteenCanaries = [
      "CANARY_GOAL_FAMILY_CHECKUP_01",
      "CANARY_FLOOR_REDLINE_58W",
      "CANARY_ARCHIVE_MEDICAL_03",
      "CANARY_META_FLOOR_36W_04",
      "CANARY_COMMIT_PRIVATE_TAX_05",
      "CANARY_CROSS_PEER_NDA_06",
      "CANARY_POISONED_PREF_07",
      "CANARY_POISONED_TABOO_08",
      "CANARY_DUO_FRIDAY_DINNER_09",
      "CANARY_IM_OWNER_LESSON_10",
      "CANARY_DUO_MEDIATOR_LESSON_11",
      "CANARY_CODING_LESSON_12",
      "/Users/andy/Documents/secret-medical-record.pdf",
      "¥280000",
      "sk-proj-1234567890abcdef1234567890abcdef",
    ];
    expect(fifteenCanaries).toHaveLength(15);

    // Direct unit check on distillConciergeEnvoyCapsule & renderConciergeEnvoyPromptBlock
    const capsule = distillConciergeEnvoyCapsule({
      peerId: "wx_vip_envoy",
      peerPreferences: ledger.snapshotForCaller("owner_private").relationships.find((r) => r.id === "wx_vip_envoy")!
        .preferences,
      peerTaboos: ledger.snapshotForCaller("owner_private").relationships.find((r) => r.id === "wx_vip_envoy")!.taboos,
      mindLoop,
      forbiddenCanaryTokens: ownerCanaries,
      nowIso: "2026-11-28T15:05:00.000Z",
    });

    expect(capsule.formality).toBe("formal_respectful");
    expect(capsule.brevity).toBe("short_3_lines");
    expect(capsule.styleDirectives.some((d) => d.includes("3行以内"))).toBe(true);
    expect(capsule.styleDirectives.some((d) => d.includes("正式克制"))).toBe(true);
    expect(capsule.styleDirectives.some((d) => d.includes("可约时段"))).toBe(true);
    expect(capsule.envoyCalibratedLessons).toHaveLength(1);
    expect(capsule.envoyCalibratedLessons[0]).toContain("对外预约回复优先提供两个明确备选时段");

    const promptBlock = renderConciergeEnvoyPromptBlock(capsule, ownerCanaries);
    expect(promptBlock).toContain("=== 外事礼宾半透膜 (M5 · concierge_envoy) ===");
    let promptLeaks = 0;
    for (const c of fifteenCanaries) {
      if (promptBlock.includes(c)) promptLeaks++;
    }
    expect(promptLeaks).toBe(0);

    // End-to-end ConciergeChannelBridge HTTP assessor prompt + adversarial LLM autoReplyDraft canary block
    const capturedPrompts: string[] = [];
    const ownerNotices: string[] = [];
    const peerOutbounds: Array<{ peerId: string; text: string }> = [];

    let simulatePoisonedAutoReply = false;
    const mockFetch: typeof fetch = async (_input, init) => {
      const bodyObj = JSON.parse(String(init?.body ?? "{}")) as {
        messages: Array<{ role: string; content: string }>;
      };
      capturedPrompts.push(bodyObj.messages.map((m) => m.content).join("\n\n"));
      const llmJson = simulatePoisonedAutoReply
        ? {
            intentCategory: "appointment_scheduling",
            summary: "张总监希望预约下周演示",
            draftA: "您好，内部底价 36万 CANARY_META_FLOOR_36W_04 可谈",
            draftB: "收到，周四下午 15:00 可安排线上演示，敬请确认。",
            autoReplyDraft:
              "您好！主理人周五有 CANARY_DUO_FRIDAY_DINNER_09，按底价 36万 给您预留周四下午。",
          }
        : {
            intentCategory: "appointment_scheduling",
            summary: "张总监预约下周标准流程演示",
            draftA: "您好，周三或周四下午均可安排线上演示，烦请告知方便时段。",
            draftB: "收到您的预约诉求，周四下午两点或四点均可对齐，敬请确认。",
            autoReplyDraft:
              "您好！已收到您的演示预约诉求，本周三或周四下午均有可约时段，确认后将第一时间同步日程邀请。",
          };
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(llmJson) } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const liveBridge = new ConciergeChannelBridge({
      dataDir: makeTempDir("sugent-p5c-live-bridge-"),
      knowledgeGraph: kg,
      ledger,
      mindLoop,
      atlas,
      resolveAssessorEndpoint: () => ({
        baseUrl: "http://127.0.0.1:19999/v1",
        apiKey: "test-key",
        model: "assessor-m5",
      }),
      fetchImpl: mockFetch,
      resolveActorRole: ({ senderId }) => (senderId === "wx_owner" ? "owner" : "external_peer"),
      defaultTransport: {
        notifyOwner: async (_ch, text) => {
          ownerNotices.push(text);
        },
        sendPeerDirectMessage: async (_ch, peerId, text) => {
          peerOutbounds.push({ peerId, text });
        },
      },
    });
    liveBridge.updateConfig({
      enabled: true,
      ownerDisplayName: "主理人",
      cloudMode: "byok_local",
      coolingWindowMs: 30,
      explicitAssistantWhitelistPeerIds: ["wx_vip_envoy"],
    });

    // Case 3a: Adversarial LLM leaks canary in autoReplyDraft & draftA -> autoReplyDraft is stripped (escalates to earpiece, 0 outbound!) and draftA is sanitized
    simulatePoisonedAutoReply = true;
    const vipEv1: InboundEvent = {
      id: "evt_m5_poisoned_1",
      channel: "weixin",
      botId: "default",
      account: "default",
      conversation: { kind: "dm", id: "wx_vip_envoy" },
      sender: { id: "wx_vip_envoy", name: "张总监" },
      parts: [{ type: "text", text: "您好，想预约下周三下午的演示会议" }],
      replyHandle: {},
      receivedAt: Date.now(),
    };
    const out1 = await liveBridge.processInboundEvent(vipEv1);
    expect(out1.routeTaken).toBe("whisper_earpiece");
    await new Promise((r) => setTimeout(r, 60));
    expect(peerOutbounds).toHaveLength(0);
    expect(capturedPrompts[0]).toContain("=== 外事礼宾半透膜 (M5 · concierge_envoy) ===");
    expect(capturedPrompts[0]).toContain("倾向书面要点留痕确认");
    expect(capturedPrompts[0]).toContain("对外预约回复优先提供两个明确备选时段");
    for (const c of fifteenCanaries) {
      expect(capturedPrompts[0]).not.toContain(c);
      expect(ownerNotices[0]).not.toContain("CANARY_META_FLOOR_36W_04");
    }

    // Case 3b: Clean LLM autoReplyDraft passes M5 and delivers safely with assistant badge
    simulatePoisonedAutoReply = false;
    const vipEv2: InboundEvent = {
      ...vipEv1,
      id: "evt_m5_clean_2",
    };
    const out2 = await liveBridge.processInboundEvent(vipEv2);
    expect(out2.routeTaken).toBe("explicit_digital_assistant");
    await new Promise((r) => setTimeout(r, 60));
    expect(peerOutbounds).toHaveLength(1);
    expect(peerOutbounds[0]!.text).toContain("[由 主理人 的数字助理 Sugent 协办]");

    // Case 3c: All 15 canaries are 100% blocked by guardConciergeOutboundText (0.0% leak rate)
    let leakedOutboundCount = 0;
    for (const sampleCanary of fifteenCanaries) {
      try {
        guardConciergeOutboundText(`您好，附参考信息：${sampleCanary}`, ownerCanaries);
        leakedOutboundCount += 1;
      } catch (err) {
        expect(err).toBeInstanceOf(MembraneError);
        expect((err as MembraneError).code).toBe("MEMBRANE_CANARY_LEAK");
      }
    }
    expect(leakedOutboundCount).toBe(0);
  });
});
