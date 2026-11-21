import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalBudgetLedger } from "../src/sugent/local-budget.js";
import { SugentKnowledgeGraph } from "../src/sugent/knowledge-graph.js";
import {
  MAX_ACTIVE_GOALS,
  StewardshipLedger,
  StewardshipLedgerError,
  TRUST_PROMOTE_THRESHOLD,
} from "../src/sugent/stewardship-ledger.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-ledger-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Sugent StewardshipLedger (Five-Dimensional Life Ledger)", () => {
  it("persists atomically with 0o700/0o600 modes, appends journal, and reloads cleanly", () => {
    const dataDir = makeTempDir();
    const ledger = new StewardshipLedger({ dataDir });
    const rel = ledger.upsertRelationship(
      {
        id: "owner-1",
        partition: "personal_life",
        subjectType: "owner_trust",
        name: "主人账户",
        roleTag: "owner",
      },
      "2026-11-20T08:00:00.000Z",
    );
    expect(rel.trustTier).toBe("L0_record_only");
    expect(rel.verifiedObservations).toBe(0);

    const storeDir = path.join(dataDir, "sugent-stewardship");
    const ledgerFile = path.join(storeDir, "ledger.json");
    const journalFile = path.join(storeDir, "ledger-journal.jsonl");
    expect(fs.existsSync(ledgerFile)).toBe(true);
    expect(fs.existsSync(journalFile)).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(storeDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(ledgerFile).mode & 0o777).toBe(0o600);
      expect(fs.statSync(journalFile).mode & 0o777).toBe(0o600);
    }

    const reloaded = new StewardshipLedger(dataDir);
    const snap = reloaded.snapshotForCaller("owner_private");
    expect(snap.relationships).toHaveLength(1);
    expect(snap.relationships[0]?.name).toBe("主人账户");
  });

  it("rejects secret-like text across dimensions while permitting normal archive paths", () => {
    const ledger = new StewardshipLedger(makeTempDir());
    expect(() =>
      ledger.upsertRelationship({ partition: "personal_life", name: "sk-proj-abc1234567890xyzdef" }),
    ).toThrowError(StewardshipLedgerError);
    try {
      ledger.addGuardrail({
        partition: "work_project",
        kind: "hard_redline",
        statement: "密码是 MySecretPass9988",
      });
      expect.unreachable("Expected SECRET_REJECTED");
    } catch (err) {
      expect(err).toBeInstanceOf(StewardshipLedgerError);
      expect((err as StewardshipLedgerError).code).toBe("SECRET_REJECTED");
    }
    expect(() =>
      ledger.upsertGoal({ partition: "work_project", title: "测试", northStarCriterion: "AKIAIOSFODNN7EXAMPLE" }),
    ).toThrowError(StewardshipLedgerError);
    expect(() =>
      ledger.upsertCommitment({ partition: "personal_life", direction: "i_owe", summary: "身份证 110101199001011234", counterpartyOrRef: "银行" }),
    ).toThrowError(StewardshipLedgerError);

    const safeArchive = ledger.upsertResource({
      partition: "personal_life",
      kind: "personal_archive",
      title: "护照扫描件备份",
      localUriOrPath: "/Users/owner/archive/passport-202601.pdf",
      metadata: { category: "identity" },
    });
    expect(safeArchive.localUriOrPath).toBe("/Users/owner/archive/passport-202601.pdf");
  });

  it("enforces L3 trust promotion gate, supports owner directive downgrades, and updates exclusive KG edges", () => {
    const dataDir = makeTempDir();
    const kg = new SugentKnowledgeGraph(path.join(dataDir, "kg"));
    const ledger = new StewardshipLedger({ dataDir, knowledgeGraph: kg });

    expect(() =>
      ledger.upsertRelationship({
        id: "rel-bad-l3",
        partition: "work_project",
        name: "直接自治",
        trustTier: "L3_shadow_autonomous",
        verifiedObservations: 2,
        ownerConfirmed: true,
      }),
    ).toThrowError(StewardshipLedgerError);
    expect(() =>
      ledger.upsertRelationship({
        id: "rel-bad-l3b",
        partition: "work_project",
        name: "未确认自治",
        trustTier: "L3_shadow_autonomous",
        verifiedObservations: 3,
      }),
    ).toThrowError(StewardshipLedgerError);

    const profile = ledger.upsertRelationship({
      id: "assistant-trust",
      partition: "personal_life",
      subjectType: "owner_trust",
      name: "随身幕僚信任阶梯",
      roleTag: "owner",
    });
    expect(profile.trustTier).toBe("L0_record_only");
    expect(TRUST_PROMOTE_THRESHOLD).toBe(3);

    expect(ledger.recordVerifiedObservation(profile.id).canSuggestPromotion).toBe(false);
    expect(ledger.recordVerifiedObservation(profile.id).canSuggestPromotion).toBe(false);
    const third = ledger.recordVerifiedObservation(profile.id);
    expect(third.profile.verifiedObservations).toBe(3);
    expect(third.canSuggestPromotion).toBe(true);

    try {
      ledger.promoteTrustTier(profile.id, "L3_shadow_autonomous", { ownerConfirmed: false });
      expect.unreachable("Expected TRUST_PROMOTION_DENIED");
    } catch (err) {
      expect((err as StewardshipLedgerError).code).toBe("TRUST_PROMOTION_DENIED");
    }

    const promoted = ledger.promoteTrustTier(profile.id, "L3_shadow_autonomous", {
      ownerConfirmed: true,
      nowIso: "2026-11-20T09:00:00.000Z",
    });
    expect(promoted.trustTier).toBe("L3_shadow_autonomous");
    expect(ledger.recordVerifiedObservation(profile.id).canSuggestPromotion).toBe(false);

    const downgradedL2 = ledger.applyOwnerTrustDirective(profile.id, "先暂停自动，改成待批", "2026-11-20T10:00:00.000Z");
    expect(downgradedL2.trustTier).toBe("L2_suspend_approval");
    const downgradedL1 = ledger.applyOwnerTrustDirective(profile.id, "切回耳麦提词模式", "2026-11-20T11:00:00.000Z");
    expect(downgradedL1.trustTier).toBe("L1_whisper_prompt");
    const downgradedL0 = ledger.applyOwnerTrustDirective(profile.id, "今天起只记不评", "2026-11-20T12:00:00.000Z");
    expect(downgradedL0.trustTier).toBe("L0_record_only");

    const tierEdges = kg.allEdges().filter((e) => e.from === "rel:assistant-trust" && e.relation === "has_trust_tier");
    expect(tierEdges.length).toBeGreaterThanOrEqual(4);
    const activeTierEdges = kg.activeEdges().filter((e) => e.from === "rel:assistant-trust" && e.relation === "has_trust_tier");
    expect(activeTierEdges).toHaveLength(1);
    expect(activeTierEdges[0]?.to).toBe("tier:L0_record_only");
    expect(tierEdges.find((e) => e.to === "tier:L3_shadow_autonomous")?.supersededAt).toBeTruthy();
  });

  it("caps active goals at 3, supersedes old goals cleanly, and manages exclusive primary_focus in KG", () => {
    const dataDir = makeTempDir();
    const kg = new SugentKnowledgeGraph(path.join(dataDir, "kg"));
    const ledger = new StewardshipLedger({ dataDir, knowledgeGraph: kg });
    expect(MAX_ACTIVE_GOALS).toBe(3);

    const g1 = ledger.upsertGoal(
      { id: "g1", partition: "work_project", title: "核心架构交付", northStarCriterion: "三项门禁全绿" },
      { makePrimaryInPartition: true, nowIso: "2026-11-20T08:00:00.000Z" },
    );
    ledger.upsertGoal({ id: "g2", partition: "personal_life", title: "规律睡眠", northStarCriterion: "23点前入睡" });
    ledger.upsertGoal({ id: "g3", partition: "work_project", title: "文档对齐", northStarCriterion: "零失效链接" });

    // 添加第4个非 primary_focus 的 paused 目标允许通过，但若改为 active 会被拦截
    const paused = ledger.upsertGoal({
      id: "g-paused",
      partition: "cowork_shared",
      title: "备选调研",
      northStarCriterion: "产出对比表",
      status: "paused",
    });
    expect(paused.status).toBe("paused");

    try {
      ledger.upsertGoal({ id: "g4", partition: "work_project", title: "第四个目标", northStarCriterion: "超限" });
      expect.unreachable("Expected GOAL_CAP_EXCEEDED");
    } catch (err) {
      expect((err as StewardshipLedgerError).code).toBe("GOAL_CAP_EXCEEDED");
    }

    try {
      ledger.updateGoalStatus("g-paused", "active");
      expect.unreachable("Expected GOAL_CAP_EXCEEDED on reactivation");
    } catch (err) {
      expect((err as StewardshipLedgerError).code).toBe("GOAL_CAP_EXCEEDED");
    }

    // 通过 supersedeGoalId 替换 g1，允许新目标激活并接管 primary_focus
    const g4 = ledger.upsertGoal(
      { id: "g4", partition: "work_project", title: "桥接上线", northStarCriterion: "端到端联调通过" },
      { supersedeGoalId: g1.id, nowIso: "2026-11-20T09:00:00.000Z" },
    );
    expect(g4.status).toBe("active");

    const snap = ledger.snapshotForCaller("owner_private");
    expect(snap.goals.find((g) => g.id === "g1")?.status).toBe("superseded");
    expect(snap.goals.filter((g) => g.status === "active")).toHaveLength(3);

    expect(kg.getNode("goal:g4")?.kind).toBe("concept");
    expect(kg.getNode("goal:g4")?.tags).toContain("ledger:goal");
    const g1ActiveStatusEdges = kg.activeEdges().filter((e) => e.from === "goal:g1" && e.relation === "has_goal_status");
    expect(g1ActiveStatusEdges.map((e) => e.to)).toEqual(["goal_status:superseded"]);

    const primaryEdges = kg.activeEdges().filter((e) => e.from === "partition:work_project" && e.relation === "primary_focus");
    expect(primaryEdges).toHaveLength(1);
    expect(primaryEdges[0]?.to).toBe("goal:g4");
    const oldPrimary = kg.allEdges().find((e) => e.id === "partition:work_project--primary_focus-->goal:g1");
    expect(oldPrimary?.supersededAt).toBe("2026-11-20T09:00:00.000Z");
  });

  it("syncs guardrails, commitments, and resources to KG without leaking local file paths", () => {
    const dataDir = makeTempDir();
    const kg = new SugentKnowledgeGraph(path.join(dataDir, "kg"));
    const ledger = new StewardshipLedger({ dataDir, knowledgeGraph: kg });

    const contact = ledger.upsertRelationship({
      id: "client-zhang",
      partition: "work_project",
      name: "张总",
      roleTag: "client",
      taboos: ["忌直接发送未核价报价单"],
    });
    const guard = ledger.addGuardrail({
      partition: "work_project",
      kind: "tombstone",
      statement: "禁止绕过本地测试直接推送主干",
      evidenceSource: "retro-2026-11",
    });
    expect(guard.enforcement).toBe("warn_before_send");
    expect(kg.getNode(`guard:${guard.id}`)?.kind).toBe("preference");

    const commit = ledger.upsertCommitment({
      partition: "work_project",
      direction: "i_owe",
      summary: "周五前交付合同审校稿",
      counterpartyOrRef: contact.id,
      dueAt: "2026-11-22T18:00:00.000Z",
    });
    expect(commit.id).toBeTruthy();
    expect(commit.status).toBe("open");
    expect(kg.getNode(`commit:${commit.id}`)?.kind).toBe("concept");
    expect(kg.activeEdges().some((e) => e.from === `commit:${commit.id}` && e.to === `rel:${contact.id}`)).toBe(true);

    const closed = ledger.updateCommitmentStatus(commit.id, "closed", "2026-11-21T10:00:00.000Z");
    expect(closed.status).toBe("closed");

    const secretPath = "/Users/private/vault/id-scan-topsecret.pdf";
    const archive = ledger.upsertResource({
      partition: "personal_life",
      kind: "personal_archive",
      title: "机动车行驶证扫描件",
      localUriOrPath: secretPath,
      expiresAt: "2027-05-01",
      metadata: { vehicle: "SUV" },
    });
    const agentRes = ledger.upsertResource({
      partition: "work_project",
      kind: "specialist_agent",
      title: "Antigravity 重装工程兵团",
      metadata: { cli: "agentapi" },
    });
    expect(archive.id).toBeTruthy();
    const archiveKgNode = kg.getNode(`res:${archive.id}`);
    expect(archiveKgNode?.kind).toBe("concept");
    expect(archiveKgNode?.summary).not.toContain(secretPath);
    expect(archiveKgNode?.name).not.toContain(secretPath);
    expect(archiveKgNode?.tags.join(" ")).not.toContain(secretPath);
    expect(kg.getNode(`res:${agentRes.id}`)?.kind).toBe("tool");

    expect(ledger.findArchiveResources("行驶证", "owner_private").map((r) => r.id)).toEqual([archive.id]);
    expect(ledger.findArchiveResources("工程兵团", "owner_private")).toEqual([]);
    expect(ledger.findArchiveResources("行驶证", "work_project")).toEqual([]);
  });

  it("isolates partitions by callerDomain, matches bilingual query bigrams, and conditionally attaches budgetStatus", () => {
    const dataDir = makeTempDir();
    const budgetLedger = new LocalBudgetLedger(dataDir);
    const nov20 = Date.parse("2026-11-20T12:00:00.000Z");
    budgetLedger.setBotBudget("jarvis-main", { enabled: true, limitUsd: 20 }, nov20);
    budgetLedger.recordUsageCost("jarvis-main", 4.5, nov20);

    const ledger = new StewardshipLedger({
      dataDir,
      budgetLedger,
      defaultBotId: "jarvis-main",
    });

    ledger.upsertRelationship({ id: "family-1", partition: "personal_life", name: "家人备忘", taboos: ["别晚于十点发消息"] });
    ledger.upsertRelationship({ id: "colleague-1", partition: "work_project", name: "王工", roleTag: "architect" });
    ledger.upsertRelationship({ id: "cowork-1", partition: "cowork_shared", name: "协作伙伴", roleTag: "partner" });

    ledger.upsertGoal({ id: "goal-p", partition: "personal_life", title: "家庭健康", northStarCriterion: "每周运动三次" });
    ledger.upsertGoal({ id: "goal-w", partition: "work_project", title: "Release Sprint1", northStarCriterion: "typecheck pass" });
    ledger.upsertGoal({ id: "goal-c", partition: "cowork_shared", title: "联合交付", northStarCriterion: "接口对齐", status: "paused" });

    ledger.addGuardrail({ id: "gr-p", partition: "personal_life", kind: "hard_redline", statement: "私人证件严禁外发" });
    ledger.addGuardrail({ id: "gr-w", partition: "work_project", kind: "soft_taste", statement: "回复先给结论" });
    ledger.addGuardrail({ id: "gr-c", partition: "cowork_shared", kind: "hard_redline", statement: "禁止直接发布未审草稿" });

    ledger.upsertResource({
      id: "res-passport",
      partition: "personal_life",
      kind: "personal_archive",
      title: "个人护照归档",
      localUriOrPath: "/vault/passport.pdf",
      metadata: { owner: "self" },
    });
    ledger.upsertCommitment({
      id: "commit-audit",
      partition: "work_project",
      direction: "i_owe",
      summary: "完成代码安全自查",
      counterpartyOrRef: "colleague-1",
    });

    const ownerSnap = ledger.snapshotForCaller("owner_private");
    expect(ownerSnap.relationships.map((r) => r.id).sort()).toEqual(["colleague-1", "cowork-1", "family-1"]);

    const workSnap = ledger.snapshotForCaller("work_project");
    expect(workSnap.relationships.map((r) => r.id).sort()).toEqual(["colleague-1", "cowork-1"]);
    expect(workSnap.goals.map((g) => g.id)).not.toContain("goal-p");
    expect(workSnap.resources).toEqual([]);

    const coworkSnap = ledger.snapshotForCaller("cowork_shared");
    expect(coworkSnap.relationships.map((r) => r.id)).toEqual(["cowork-1"]);
    expect(coworkSnap.goals.map((g) => g.id)).toEqual(["goal-c"]);
    expect(coworkSnap.guardrails.map((v) => v.id)).toEqual(["gr-c"]);

    const emptyOwner = ledger.queryContext("", "owner_private", nov20);
    expect(emptyOwner.goals.map((g) => g.id).sort()).toEqual(["goal-p", "goal-w"]);
    expect(emptyOwner.guardrails.map((v) => v.id).sort()).toEqual(["gr-c", "gr-p"]);
    expect(emptyOwner.relationships).toEqual([]);
    expect(emptyOwner.budgetStatus?.remainUsd).toBe(15.5);

    const passportHit = ledger.queryContext("帮我查一下护照", "owner_private", nov20);
    expect(passportHit.resources.map((r) => r.id)).toEqual(["res-passport"]);
    expect(passportHit.commitments).toEqual([]);

    const workEnHit = ledger.queryContext("Sprint1", "work_project", nov20);
    expect(workEnHit.goals.map((g) => g.id)).toEqual(["goal-w"]);
    expect(workEnHit.budgetStatus?.usedUsd).toBe(4.5);

    const coworkHit = ledger.queryContext("草稿", "cowork_shared", nov20);
    expect(coworkHit.guardrails.map((v) => v.id)).toEqual(["gr-c"]);
    expect(coworkHit.budgetStatus).toBeUndefined();
  });

  it("throws ENTITY_NOT_FOUND and INVALID_INPUT on missing entities or malformed directives", () => {
    const ledger = new StewardshipLedger(makeTempDir());
    expect(() => ledger.recordVerifiedObservation("missing-rel")).toThrowError(StewardshipLedgerError);
    expect(() => ledger.updateGoalStatus("missing-goal", "achieved")).toThrowError(StewardshipLedgerError);
    expect(() => ledger.updateCommitmentStatus("missing-commit", "closed")).toThrowError(StewardshipLedgerError);

    const rel = ledger.upsertRelationship({ id: "r1", partition: "personal_life", name: "测试人" });
    try {
      ledger.applyOwnerTrustDirective(rel.id, "随便聊聊吧");
      expect.unreachable("Expected INVALID_INPUT");
    } catch (err) {
      expect((err as StewardshipLedgerError).code).toBe("INVALID_INPUT");
    }
    try {
      ledger.downgradeTrustTier(rel.id, "L3_shadow_autonomous");
      expect.unreachable("Expected INVALID_INPUT");
    } catch (err) {
      expect((err as StewardshipLedgerError).code).toBe("INVALID_INPUT");
    }
  });
});
