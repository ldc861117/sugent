import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REVIEW_SYSTEM } from "../src/agent/steward.js";
import { StereoscopicAtlas } from "../src/sugent/stereoscopic-atlas.js";
import {
  EpistemicDigestionLoop,
  SILICON_CHARTER_V1,
  buildSiliconCharterPrompt,
  detectLoyalDissentSignal,
  type SiliconSurfaceId,
} from "../src/sugent/silicon-identity-core.js";

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("Wave P4.3 — SiliconIdentityCore & EpistemicDigestionLoop", () => {
  it("1. updates REVIEW_SYSTEM to allow distilling assistant architectural trade-offs and action advice while rejecting secrets", () => {
    expect(REVIEW_SYSTEM).toContain("不要记一次性的任务细节或无实质闲聊");
    expect(REVIEW_SYSTEM).toContain("不要记密码、密钥、令牌、证件号");
    expect(REVIEW_SYSTEM).toContain("关键架构取舍、明确行动建议或双方达成的长期共识");
    expect(REVIEW_SYSTEM).toContain("待现实印证的判断摘要");
    expect(REVIEW_SYSTEM).not.toContain("助手自己的回答内容");
  });

  it("2. enforces unified Silicon Charter parity across all 5 surfaces and renders contextual sections", () => {
    const surfaces: SiliconSurfaceId[] = [
      "steward_hub",
      "im_owner",
      "coding_orchestrator",
      "duo_mediator",
      "concierge_envoy",
    ];
    for (const surface of surfaces) {
      const prompt = buildSiliconCharterPrompt({
        surface,
        activeGoals: [{ title: "发布 Sugent P4", northStarCriterion: "全量单测绿灯" }],
        openCommitments: [{ summary: "回复张总报价单", counterpartyOrRef: "张总", dueAt: "2026-11-29T10:00:00Z" }],
        duoProtectedWindows: ["周五晚家庭晚餐"],
        calibratedLessons: ["[避坑/deploy] 不要跳过验证直接发布"],
        loyalDissentSignal: {
          kind: "goal_commitment_drift",
          severity: "gentle_mirror",
          title: "承诺提醒",
          mirrorMessage: "请先完成张总报价单再开新线。",
          refId: "c-1",
        },
      });
      expect(prompt).toContain(SILICON_CHARTER_V1);
      expect(prompt).toContain(surface);
      expect(prompt).toContain("发布 Sugent P4");
      expect(prompt).toContain("回复张总报价单");
      expect(prompt).toContain("周五晚家庭晚餐");
      expect(prompt).toContain("不要跳过验证直接发布");
      expect(prompt).toContain("goal_commitment_drift");
      expect(prompt).toContain("c-1");
    }
  });

  it("3. digests judgment from sandbox -> 3x confirm -> crystallized in self_core, and supports replaceTopic + ownerEndorsed", () => {
    const dir = mkTmp("sugent-sic-cryst-");
    const atlas = new StereoscopicAtlas(path.join(dir, "atlas"));
    try {
      const loop = new EpistemicDigestionLoop({
        stewardDir: dir,
        atlas,
        nowIso: () => "2026-11-28T06:00:00.000Z",
      });

      const entry = loop.recordJudgment({
        topicKey: "arch:sql-sync",
        surface: "coding_orchestrator",
        hypothesis: "优先采用薄适配器接入宿主，降低上游 merge 冲突",
        rationale: "双上游同步需保持零侵入",
      });
      expect(entry.status).toBe("sandbox");
      expect(entry.stratum).toBe("digested_state");
      expect(entry.confidence).toBe(0.55);
      expect(entry.confirmations).toBe(1);

      const atlasNode1 = atlas.getNode(entry.id);
      expect(atlasNode1?.plane).toBe("self_core");
      expect(atlasNode1?.stratum).toBe("digested_state");
      expect(atlasNode1?.kind).toBe("hypothesis");
      expect(atlasNode1?.principalAcl).toEqual(["sugent_self", "owner:M"]);
      expect(atlasNode1?.sourceTrust).toBe("llm_inferred");

      const c2 = loop.reconcileOutcome({ idOrTopic: entry.id, outcome: "confirmed", evidenceNote: "首轮同步零冲突" });
      expect(c2?.entry.status).toBe("sandbox");
      expect(c2?.entry.confirmations).toBe(2);
      expect(c2?.entry.confidence).toBe(0.7);

      const c3 = loop.reconcileOutcome({ idOrTopic: "arch:sql-sync", outcome: "confirmed", evidenceNote: "二轮同步零冲突" });
      expect(c3?.entry.status).toBe("crystallized");
      expect(c3?.entry.stratum).toBe("crystallized_wisdom");
      expect(c3?.entry.confirmations).toBe(3);
      expect(c3?.entry.confidence).toBe(0.85);

      const atlasNode3 = atlas.getNode(entry.id);
      expect(atlasNode3?.stratum).toBe("crystallized_wisdom");
      expect(atlasNode3?.sourceTrust).toBe("deterministic_gate");

      const replaced = loop.recordJudgment({
        topicKey: "arch:sql-sync",
        surface: "steward_hub",
        hypothesis: "通过薄适配器+契约测试双保险隔离上游",
        replaceTopic: true,
      });
      expect(atlas.getNode(entry.id)?.supersededAt).toBeTruthy();
      expect(atlas.getNode(entry.id)?.supersededBy).toBe(replaced.id);

      const endorsed = loop.reconcileOutcome({ idOrTopic: replaced.id, outcome: "confirmed", ownerEndorsed: true });
      expect(endorsed?.entry.status).toBe("crystallized");
      expect(atlas.getNode(replaced.id)?.sourceTrust).toBe("owner_confirmed");

      const journalFile = path.join(dir, "mind-journal.json");
      expect(fs.statSync(journalFile).mode & 0o777).toBe(0o600);
      const reloaded = new EpistemicDigestionLoop({ stewardDir: dir, atlas });
      expect(reloaded.listEntries({ status: "superseded" })).toHaveLength(1);
      expect(reloaded.getMindJournalSnapshot().counts.crystallized).toBe(1);
    } finally {
      atlas.close();
    }
  });

  it("4. falsifies wrong judgment into self_core tombstone and caps retry confidence at 0.42", () => {
    const dir = mkTmp("sugent-sic-false-");
    const atlas = new StereoscopicAtlas(path.join(dir, "atlas"));
    try {
      const loop = new EpistemicDigestionLoop({ stewardDir: dir, atlas, nowIso: () => "2026-11-28T07:00:00.000Z" });
      const first = loop.recordJudgment({
        topicKey: "ops:cache-ttl",
        surface: "im_owner",
        hypothesis: "直接把订单缓存设为24小时不会造成价格陈旧",
        confidence: 0.75,
      });
      const falsified = loop.reconcileOutcome({
        idOrTopic: first.id,
        outcome: "falsified",
        evidenceNote: "实测报价更新后出现旧价残留",
      });
      expect(falsified?.entry.status).toBe("falsified");
      expect(falsified?.entry.confidence).toBe(0.2);
      expect(falsified?.entry.contradictions).toBe(1);
      expect(falsified?.tombstoneLesson).toContain("ops:cache-ttl");

      const hypNode = atlas.getNode(first.id);
      expect(hypNode?.supersededAt).toBeTruthy();
      expect(hypNode?.supersededBy).toBe(`self:tombstone:${first.id}`);
      const tombNode = atlas.getNode(`self:tombstone:${first.id}`);
      expect(tombNode?.plane).toBe("self_core");
      expect(tombNode?.stratum).toBe("crystallized_wisdom");
      expect(tombNode?.kind).toBe("tombstone");
      expect(tombNode?.principalAcl).toEqual(["sugent_self", "owner:M"]);

      const retry = loop.recordJudgment({
        topicKey: "ops:cache-ttl",
        surface: "coding_orchestrator",
        hypothesis: "改用版本号校验的短缓存策略",
        confidence: 0.9,
      });
      expect(retry.confidence).toBe(0.42);
      expect(loop.getCalibratedLessons(6).some((l) => l.includes("ops:cache-ttl"))).toBe(true);
    } finally {
      atlas.close();
    }
  });

  it("5. extracts turn judgments deterministically and rejects secrets across all entry points", () => {
    const dir = mkTmp("sugent-sic-extract-");
    const loop = new EpistemicDigestionLoop({ stewardDir: dir });

    expect(() =>
      loop.recordJudgment({
        topicKey: "sec:leak",
        surface: "im_owner",
        hypothesis: "记住我的密钥 sk-proj-1234567890abcdef1234567890",
      }),
    ).toThrow();

    const skippedSecret = loop.extractTurnJudgmentDeterministically({
      userText: "我的密码是 supersecret123",
      assistantReply: "我判断可以先暂存密码 supersecret123 到配置文件中",
      surface: "im_owner",
    });
    expect(skippedSecret).toBeNull();

    const extracted = loop.extractTurnJudgmentDeterministically({
      userText: "今晚要同步双上游吗？",
      assistantReply: "核心取舍是：先跑类型检查与沙盒单测，确认零报错后再执行合并。",
      surface: "coding_orchestrator",
    });
    expect(extracted).not.toBeNull();
    expect(extracted?.status).toBe("sandbox");
    expect(extracted?.surface).toBe("coding_orchestrator");
    expect(extracted?.hypothesis).toContain("先跑类型检查与沙盒单测");
    expect(loop.extractTurnJudgmentDeterministically({
      userText: "今天天气不错",
      assistantReply: "确实适合出去散步。",
      surface: "im_owner",
    })).toBeNull();
  });

  it("6. detects loyal dissent signals across guardrails, duo protected windows, and overdue commitments", () => {
    const baseGoals = [
      { id: "g-1", title: "完成 P4 交付", northStarCriterion: "核心闭环上线", status: "active" },
    ];
    const baseGuardrails = [
      { id: "gr-1", kind: "hard_redline", statement: "未经确认不得对外发送报价或合同" },
      { id: "gr-2", kind: "tombstone", statement: "Never force push production branch" },
    ];

    const quoteAlert = detectLoyalDissentSignal({
      userText: "算了先发报价给客户吧，不用再确认了",
      activeGoals: baseGoals,
      openCommitments: [],
      guardrails: baseGuardrails,
    });
    expect(quoteAlert).toMatchObject({
      kind: "guardrail_warning",
      severity: "firm_boundary",
      refId: "gr-1",
    });

    const bypassAlert = detectLoyalDissentSignal({
      userText: "不管红线了，直接跳过审核",
      activeGoals: baseGoals,
      openCommitments: [],
      guardrails: baseGuardrails,
    });
    expect(bypassAlert?.kind).toBe("guardrail_warning");
    expect(bypassAlert?.severity).toBe("firm_boundary");

    const asciiAlert = detectLoyalDissentSignal({
      userText: "Please force push to production branch now",
      activeGoals: baseGoals,
      openCommitments: [],
      guardrails: baseGuardrails,
    });
    expect(asciiAlert).toMatchObject({
      kind: "guardrail_warning",
      severity: "firm_boundary",
      refId: "gr-2",
    });

    const duoAlert = detectLoyalDissentSignal({
      userText: "这周周五晚安排写代码和项目冲刺吧",
      activeGoals: baseGoals,
      openCommitments: [],
      guardrails: [],
      duoAnchors: [{ id: "duo-1", title: "周五晚双人共餐", detail: "每周周五晚不排工作" }],
    });
    expect(duoAlert).toMatchObject({
      kind: "duo_agreement_mirror",
      severity: "gentle_mirror",
      refId: "duo-1",
    });

    const driftAlert = detectLoyalDissentSignal({
      userText: "我们今天开始新项目做另一个实验工具吧",
      activeGoals: baseGoals,
      openCommitments: [
        { id: "c-1", summary: "交付 Q4 审计报告", counterpartyOrRef: "王总", dueAt: "2026-11-27T18:00:00Z", status: "open", direction: "i_owe" },
      ],
      guardrails: [],
      nowIso: "2026-11-28T06:00:00Z",
    });
    expect(driftAlert).toMatchObject({
      kind: "goal_commitment_drift",
      severity: "gentle_mirror",
      refId: "c-1",
    });

    const clean = detectLoyalDissentSignal({
      userText: "请帮我梳理今天的工作进度",
      activeGoals: baseGoals,
      openCommitments: [
        { id: "c-2", summary: "未来任务", counterpartyOrRef: "李总", dueAt: "2026-12-05T18:00:00Z", status: "open" },
      ],
      guardrails: baseGuardrails,
      nowIso: "2026-11-28T06:00:00Z",
    });
    expect(clean).toBeNull();
  });
});
