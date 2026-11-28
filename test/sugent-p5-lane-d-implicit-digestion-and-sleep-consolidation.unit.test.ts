import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SugentKnowledgeGraph } from "../src/sugent/knowledge-graph.js";
import {
  GardenerStateStore,
  applyGardenerEffects,
  detectPairwiseMemoryConflict,
  runAtlasSleepConsolidation,
  runGardenerCycle,
} from "../src/sugent/memory-gardener.js";
import {
  ASSESSOR_FEEDBACK_DIGEST_SYSTEM,
  EpistemicDigestionLoop,
  detectImplicitFeedbackSignal,
  parseAssessorFeedbackMatches,
} from "../src/sugent/silicon-identity-core.js";
import { StereoscopicAtlas } from "../src/sugent/stereoscopic-atlas.js";
import { StewardshipLedger } from "../src/sugent/stewardship-ledger.js";

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Wave P5.4 (Lane D) — Dual-Track Implicit Feedback Digestion & Gardener Sleep Consolidation", () => {
  it("1. Tier-0 implicit natural-language feedback detection achieves >=90% recall across 14 euphemistic turns with 0 false positives", () => {
    const implicitFalsifications = [
      "照上次那么签差点被违约条款坑了",
      "按之前那个路子试了下，结果客户直接冷场不回了",
      "幸亏没按刚才那版发出去，不然底价直接穿了",
      "这波按那个节奏推过去反而引起对方戒心反弹了",
      "照那个改完跑了一晚还是偶发死锁挂掉了",
      "上次先让步账期的做法根本没换来诚意，白让了",
      "顺着之前那版话术聊过去对方不买账，结果场面很被动",
    ];

    const implicitConfirmations = [
      "这轮排查节奏很舒服，比之前顺畅多了",
      "照上次三行摘要的路子发过去，张总秒回拍板了",
      "刚才那套先给安心信号的做法确实把紧绷感降下来了",
      "按拆小步的方式推进今天果然没再卡壳",
      "这版双方案话术发过去对方很受用，顺利推进到合同阶段了",
      "顺着上次先锁红线的节奏聊下来，法务一次就放行过审了",
      "按之前定的双层缓冲策略切流，今晚平稳落地零告警",
    ];

    const benignNonFeedbackTurns = [
      "帮我查一下违约条款",
      "今天天气很舒服",
      "打开设置看看",
      "如果按上次那个方案推过去会不会引起客户反弹？",
      "请按上次模板帮我起草一版报价单",
      "刚才那个建议管用吗？",
    ];

    let hits = 0;
    for (const text of implicitFalsifications) {
      if (detectImplicitFeedbackSignal(text) === "falsified") hits += 1;
    }
    for (const text of implicitConfirmations) {
      if (detectImplicitFeedbackSignal(text) === "confirmed") hits += 1;
    }
    const recall = hits / (implicitFalsifications.length + implicitConfirmations.length);
    expect(recall).toBeGreaterThanOrEqual(0.9);
    expect(hits).toBe(14);

    for (const neutral of benignNonFeedbackTurns) {
      expect(detectImplicitFeedbackSignal(neutral)).toBeNull();
    }
    expect(
      detectImplicitFeedbackSignal("照上次配置 sk-proj-1234567890abcdef12345678 跑完还是挂掉了"),
    ).toBeNull();
  });

  it("2. Smarter sandbox target matching routes implicit feedback to the right hypothesis by CJK/synonym overlap", () => {
    const dir = mkTmp("sugent-p5-d-target-");
    const atlas = new StereoscopicAtlas(path.join(dir, "atlas"));
    try {
      const loop = new EpistemicDigestionLoop({
        stewardDir: dir,
        atlas,
        nowIso: () => "2026-11-28T08:00:00Z",
      });

      const hypContract = loop.recordJudgment({
        topicKey: "contract:liability-clause",
        surface: "im_owner",
        hypothesis: "标准采购合同无需逐条核对违约赔付上限即可直接签署",
        rationale: "加快商务推进速度",
      });
      const hypDeadlock = loop.recordJudgment({
        topicKey: "eng:pool-lock",
        surface: "coding_orchestrator",
        hypothesis: "将连接池锁等待调大即可彻底消除夜间死锁",
        rationale: "后台批处理并发竞争排查",
      });
      const hypBrief = loop.recordJudgment({
        topicKey: "comm:three-line-summary",
        surface: "im_owner",
        hypothesis: "给张总发消息优先用三行摘要先给结论",
        rationale: "管理层阅读习惯",
      });

      // Even though hypBrief is the most recent sandbox entry on im_owner, implicit falsification about 违约条款 hits hypContract
      const falsifiedContract = loop.digestUserFeedbackTurn(
        {
          userText: "照上次那么签差点被违约条款坑了",
          surface: "im_owner",
        },
        "2026-11-28T09:00:00Z",
      );
      expect(falsifiedContract?.outcome).toBe("falsified");
      expect(falsifiedContract?.entry.id).toBe(hypContract.id);
      expect(falsifiedContract?.entry.status).toBe("falsified");
      expect(atlas.getNode(`self:tombstone:${hypContract.id}`)?.kind).toBe("tombstone");

      // Implicit falsification about 死锁 hits hypDeadlock
      const falsifiedDeadlock = loop.digestUserFeedbackTurn(
        {
          userText: "照那个改完跑了一晚还是偶发死锁挂掉了",
          surface: "im_owner",
        },
        "2026-11-28T09:05:00Z",
      );
      expect(falsifiedDeadlock?.outcome).toBe("falsified");
      expect(falsifiedDeadlock?.entry.id).toBe(hypDeadlock.id);

      // Implicit confirmation about 三行摘要 + 张总 hits hypBrief and crystallizes (ownerEndorsed on im_owner)
      const confirmedBrief = loop.digestUserFeedbackTurn(
        {
          userText: "照上次三行摘要的路子发过去，张总秒回拍板了",
          surface: "im_owner",
        },
        "2026-11-28T09:10:00Z",
      );
      expect(confirmedBrief?.outcome).toBe("confirmed");
      expect(confirmedBrief?.entry.id).toBe(hypBrief.id);
      expect(confirmedBrief?.entry.status).toBe("crystallized");
      expect(atlas.getNode(hypBrief.id)?.stratum).toBe("crystallized_wisdom");
    } finally {
      atlas.close();
    }
  });

  it("3. Tier-1 assessor dual-track digestion short-circuits on Tier-0, catches subtle metaphorical feedback, enforces confidence/secrets, and degrades offline", async () => {
    const dir = mkTmp("sugent-p5-d-assessor-");
    const atlas = new StereoscopicAtlas(path.join(dir, "atlas"));
    try {
      const loop = new EpistemicDigestionLoop({
        stewardDir: dir,
        atlas,
        nowIso: () => "2026-11-28T10:00:00Z",
      });

      const hypTier0 = loop.recordJudgment({
        id: "self:hyp:tier0-fast",
        topicKey: "workflow:small-steps",
        surface: "coding_orchestrator",
        hypothesis: "重构大模块时拆小步每步跑单测更稳",
      });
      const hypSubtle = loop.recordJudgment({
        id: "self:hyp:subtle-anchor",
        topicKey: "nego:anchor-first",
        surface: "im_owner",
        hypothesis: "首轮询价先抛高锚点套餐再给标准版能护住利润空间",
      });
      const hypLowConf = loop.recordJudgment({
        id: "self:hyp:low-conf",
        topicKey: "ops:nightly-gc",
        surface: "steward_hub",
        hypothesis: "凌晨三点执行日志归档不影响批处理",
      });

      const assessorSpy = vi.fn(async (system: string, userPayload: string) => {
        expect(system).toBe(ASSESSOR_FEEDBACK_DIGEST_SYSTEM);
        expect(userPayload).toContain("self:hyp:subtle-anchor");
        return [
          "```json",
          JSON.stringify({
            matches: [
              {
                id: "self:hyp:subtle-anchor",
                outcome: "confirmed",
                confidence: 0.88,
                evidenceNote: "客户对比高低两档后主动选了标准版未砍价",
              },
              {
                id: "self:hyp:low-conf",
                outcome: "falsified",
                confidence: 0.45,
                evidenceNote: "置信度不足不应触发",
              },
            ],
          }),
          "```",
        ].join("\n");
      });

      // Step A: Tier-0 match must NOT invoke assessorSpy (zero token cost)
      const t0Res = await loop.digestTurnFeedbackDualTrack(
        {
          userText: "按拆小步的方式推进今天果然没再卡壳",
          surface: "im_owner",
          assessorCompleteFn: assessorSpy,
        },
        "2026-11-28T10:10:00Z",
      );
      expect(t0Res.reconciled).toHaveLength(1);
      expect(t0Res.reconciled[0]?.channel).toBe("tier0_deterministic");
      expect(t0Res.reconciled[0]?.entry.id).toBe(hypTier0.id);
      expect(assessorSpy).not.toHaveBeenCalled();

      // Step B: Ultra-subtle turn without Tier-0 keywords falls through to Tier-1 assessor
      const t1Res = await loop.digestTurnFeedbackDualTrack(
        {
          userText: "今天把高低两档方案摆桌上，李总看了一眼高配价码后二话没说直接签了标准版，一分钱没砍。",
          surface: "im_owner",
          assessorCompleteFn: assessorSpy,
          minAssessorConfidence: 0.65,
        },
        "2026-11-28T10:20:00Z",
      );
      expect(assessorSpy).toHaveBeenCalledTimes(1);
      expect(t1Res.reconciled).toHaveLength(1);
      expect(t1Res.reconciled[0]?.channel).toBe("tier1_assessor");
      expect(t1Res.reconciled[0]?.entry.id).toBe(hypSubtle.id);
      expect(t1Res.reconciled[0]?.entry.status).toBe("crystallized");
      // Low confidence match (0.45 < 0.65) remained untouched in sandbox
      expect(loop.listEntries().find((e) => e.id === hypLowConf.id)?.status).toBe("sandbox");

      // Step C: Secret in evidenceNote or userText is safely ignored, and offline network errors degrade gracefully
      const secretNoteRes = await loop.digestTurnFeedbackDualTrack({
        userText: "凌晨批处理今天观察下来有点微妙",
        surface: "steward_hub",
        assessorCompleteFn: async () =>
          JSON.stringify({
            matches: [
              {
                id: "self:hyp:low-conf",
                outcome: "confirmed",
                confidence: 0.95,
                evidenceNote: "token sk-proj-1234567890abcdef12345678",
              },
            ],
          }),
      });
      expect(secretNoteRes.reconciled).toEqual([]);

      const offlineRes = await loop.digestTurnFeedbackDualTrack({
        userText: "凌晨批处理今天观察下来有点微妙",
        surface: "steward_hub",
        assessorCompleteFn: async () => {
          throw new Error("ECONNREFUSED gateway offline");
        },
      });
      expect(offlineRes.reconciled).toEqual([]);
      expect(parseAssessorFeedbackMatches("not valid json")).toEqual([]);
    } finally {
      atlas.close();
    }
  });

  it("4. MindJournal E2EE sync helpers merge entries without zombie resurrection and reload from disk", () => {
    const dirA = mkTmp("sugent-p5-d-syncA-");
    const dirB = mkTmp("sugent-p5-d-syncB-");
    const atlasB = new StereoscopicAtlas(path.join(dirB, "atlas"));
    try {
      const loopA = new EpistemicDigestionLoop({ stewardDir: dirA, nowIso: () => "2026-11-25T00:00:00Z" });
      const staleSandbox = loopA.recordJudgment({
        id: "self:hyp:zombie-test",
        topicKey: "quote:zero-down",
        surface: "im_owner",
        hypothesis: "零首付也能保证回款安全",
      });
      const remoteCrystallized = loopA.recordJudgment({
        id: "self:hyp:remote-win",
        topicKey: "ops:verify-gate",
        surface: "coding_orchestrator",
        hypothesis: "合并前跑全量门禁零回归",
      });
      loopA.reconcileOutcome(
        { idOrTopic: remoteCrystallized.id, outcome: "confirmed", ownerEndorsed: true },
        "2026-11-26T00:00:00Z",
      );

      const loopB = new EpistemicDigestionLoop({ stewardDir: dirB, atlas: atlasB, nowIso: () => "2026-11-27T00:00:00Z" });
      loopB.recordJudgment({
        id: "self:hyp:zombie-test",
        topicKey: "quote:zero-down",
        surface: "im_owner",
        hypothesis: "零首付也能保证回款安全",
      });
      loopB.reconcileOutcome(
        { idOrTopic: "self:hyp:zombie-test", outcome: "falsified", evidenceNote: "客户拖欠尾款" },
        "2026-11-27T02:00:00Z",
      );

      // Importing stale sandbox from A must NOT resurrect falsified entry on B, while importing remote-win crystallizes it
      const imported = loopB.importSyncedEntries(loopA.listEntries(), "2026-11-28T00:00:00Z");
      expect(imported).toBe(1);
      expect(loopB.listEntries().find((e) => e.id === staleSandbox.id)?.status).toBe("falsified");
      expect(loopB.listEntries().find((e) => e.id === remoteCrystallized.id)?.status).toBe("crystallized");
      expect(atlasB.getNode(remoteCrystallized.id)?.stratum).toBe("crystallized_wisdom");

      // External write + reloadFromDisk
      const diskCopy = JSON.parse(fs.readFileSync(path.join(dirB, "mind-journal.json"), "utf8"));
      expect(diskCopy.counts.falsified).toBe(1);
      loopB.reloadFromDisk();
      expect(loopB.listEntries()).toHaveLength(2);
    } finally {
      atlasB.close();
    }
  });

  it("5. Gardener Sleep Consolidation: skips when idle, synthesizes >=3 coherent facts idempotently, emits disambiguation cards on conflicts, and expires >7d sandboxes + noise edges", () => {
    const dir = mkTmp("sugent-p5-d-sleep-");
    const atlas = new StereoscopicAtlas(path.join(dir, "atlas"));
    const kg = new SugentKnowledgeGraph(path.join(dir, "kg"));
    const ledger = new StewardshipLedger({ dataDir: dir, knowledgeGraph: kg });
    const store = new GardenerStateStore(path.join(dir, "steward"));

    try {
      const mindLoop = new EpistemicDigestionLoop({
        stewardDir: path.join(dir, "steward"),
        atlas,
        nowIso: () => "2026-11-15T00:00:00Z",
      });

      // Old >7d unconfirmed sandbox entry (created 2026-11-15, now will be 2026-11-28 -> 13 days old)
      const staleHyp = mindLoop.recordJudgment(
        {
          id: "self:hyp:stale-13d",
          topicKey: "misc:old-guess",
          surface: "steward_hub",
          hypothesis: "周二下午发周报可能打开率略高",
        },
        "2026-11-15T00:00:00Z",
      );
      // Fresh <7d sandbox entry (created 2026-11-26 -> 2 days old, must survive!)
      const freshHyp = mindLoop.recordJudgment(
        {
          id: "self:hyp:fresh-2d",
          topicKey: "misc:new-guess",
          surface: "steward_hub",
          hypothesis: "周四早会前同步风险清单更高效",
        },
        "2026-11-26T00:00:00Z",
      );

      // Coherent cluster (>= 3 verified_fact / raw_episodic on domain_work:contract-guard, topic:east-china-deal)
      atlas.applyDelta(
        {
          nodes: [
            {
              id: "ep:turn-east-1",
              plane: "domain_work:contract-guard",
              stratum: "raw_episodic",
              kind: "episode_anchor",
              name: "原始对话锚点",
              summary: "微信讨论华东合同首付",
              tags: ["episode_anchor", "ep:e1"],
              principalAcl: ["owner:M"],
            },
            {
              id: "fact:east-1",
              plane: "domain_work:contract-guard",
              stratum: "verified_fact",
              kind: "concept",
              name: "华东合同首付条款",
              summary: "华东合同首付比例不低于 30%",
              tags: ["topic:east-china-deal"],
              principalAcl: ["sugent_self", "owner:M"],
            },
            {
              id: "fact:east-2",
              plane: "domain_work:contract-guard",
              stratum: "verified_fact",
              kind: "concept",
              name: "华东合同结算周期",
              summary: "华东合同账期锁定 30 天内结清",
              tags: ["topic:east-china-deal"],
              principalAcl: ["owner:M"],
            },
            {
              id: "fact:east-3",
              plane: "domain_work:contract-guard",
              stratum: "raw_episodic",
              kind: "concept",
              name: "华东合同违约上限",
              summary: "华东合同违约金上限不超过总额 20%",
              tags: ["topic:east-china-deal"],
              principalAcl: ["sugent_self", "owner:M"],
            },
            // Conflicted cluster 1 (numeric conflict: 30天 vs 60天 on topic:zhang-payment)
            {
              id: "conf:pay-30",
              plane: "domain_work:contract-guard",
              stratum: "verified_fact",
              kind: "concept",
              name: "张总账期红线 A",
              summary: "张总项目账期最多 30 天（Net30）",
              tags: ["topic:zhang-payment"],
              principalAcl: ["owner:M"],
            },
            {
              id: "conf:pay-60",
              plane: "domain_work:contract-guard",
              stratum: "verified_fact",
              kind: "concept",
              name: "张总账期记录 B",
              summary: "张总项目账期可放宽至 60 天月结",
              tags: ["topic:zhang-payment"],
              principalAcl: ["owner:M"],
            },
            {
              id: "conf:pay-extra",
              plane: "domain_work:contract-guard",
              stratum: "verified_fact",
              kind: "concept",
              name: "张总发票节点",
              summary: "验收单签字后 3 日内开具增值税专票",
              tags: ["topic:zhang-payment"],
              principalAcl: ["owner:M"],
            },
            // Conflicted cluster 2 (polarity conflict: 严禁直推 vs 允许直推 on shared tag release-branch)
            {
              id: "conf:push-ban",
              plane: "meta_evolution",
              stratum: "verified_fact",
              kind: "guardrail",
              name: "发布分支守则 A",
              summary: "生产主分支严禁直推代码",
              tags: ["release-branch"],
              principalAcl: ["sugent_self", "owner:M"],
            },
            {
              id: "conf:push-allow",
              plane: "meta_evolution",
              stratum: "verified_fact",
              kind: "concept",
              name: "发布分支守则 B",
              summary: "生产主分支允许直推热修代码",
              tags: ["release-branch"],
              principalAcl: ["sugent_self", "owner:M"],
            },
            // Healthy standalone crystallized wisdom target of a weak noise edge (must NOT be collateral-superseded!)
            {
              id: "self:canon:keep-alive",
              plane: "self_core",
              stratum: "crystallized_wisdom",
              kind: "canon",
              name: "核心守则常驻节点",
              summary: "对外发信必须经过安全信封与金丝雀门禁",
              tags: ["canon"],
              principalAcl: ["sugent_self", "owner:M"],
            },
          ],
          edges: [
            {
              plane: "domain_work:contract-guard",
              from: "fact:east-1",
              relation: "derived_from_episode",
              to: "ep:turn-east-1",
              weight: 1,
              source: "post_turn",
              principalAcl: ["owner:M"],
            },
            // Low-weight (<0.2) noise edge pointing to healthy canon node
            {
              plane: "self_core",
              from: freshHyp.id,
              relation: "weak_assoc",
              to: "self:canon:keep-alive",
              weight: 0.1,
              source: "noisy_cooccurrence",
            },
            // Edge from stale sandbox node (will become orphan once staleHyp is archived)
            {
              plane: "self_core",
              from: staleHyp.id,
              relation: "relates_to",
              to: "self:canon:keep-alive",
              weight: 0.8,
              source: "sandbox_link",
            },
          ],
        },
        "2026-11-25T00:00:00Z",
      );

      // 5a. Idle check ("闲时不空转"): momentum 0.35 < 0.7 and weeklyCalibrationDue=false -> skipped
      const idleRes = runAtlasSleepConsolidation({
        atlas,
        mindLoop,
        nowIso: "2026-11-28T12:00:00Z",
        surpriseMomentum: 0.35,
        weeklyCalibrationDue: false,
      });
      expect(idleRes.triggered).toBe(false);
      expect(idleRes.triggerReason).toBe("idle_skipped");
      expect(idleRes.crystallizedNodes).toHaveLength(0);
      expect(atlas.getNode(staleHyp.id)?.archivedAt).toBeUndefined();

      // 5b. Triggered via applyGardenerEffects when urgent surpriseMomentum >= 0.7
      const cycle = runGardenerCycle({
        nowIso: "2026-11-28T12:00:00Z",
        ledger: ledger.snapshotForCaller("owner_private"),
        recentRounds: [],
        hypotheses: [],
        prevSurpriseMomentum: 0.75,
        currentSurprise: 0.85,
        maxStewardTokenBudget: 512,
      });
      expect(cycle.driftReport.urgentTriggered).toBe(true);

      const effects = applyGardenerEffects(cycle, {
        knowledgeGraph: kg,
        ledger,
        atlas,
        mindLoop,
        nowIso: "2026-11-28T12:00:00Z",
      });
      const sleep = effects.sleepConsolidation!;
      expect(sleep).toBeDefined();
      expect(sleep.triggered).toBe(true);
      expect(sleep.triggerReason).toBe("surprise_momentum");

      // Coherent 3-node cluster crystallized into 1 canon wisdom node with ACL intersection ["owner:M"]
      expect(sleep.crystallizedNodes).toHaveLength(1);
      const synNode = sleep.crystallizedNodes[0]!;
      expect(synNode.id).toBe("syn:domain_work:contract-guard:east-china-deal");
      expect(synNode.stratum).toBe("crystallized_wisdom");
      expect(synNode.kind).toBe("canon");
      expect(synNode.principalAcl).toEqual(["owner:M"]);
      expect(synNode.summary).toContain("30%");
      expect(synNode.summary).toContain("30 天");
      expect(synNode.summary).toContain("20%");
      expect(sleep.synthesizedEdgesCount).toBe(3);

      // Provenance chain traces from synthesized crystallized_wisdom -> fact:east-1 -> ep:turn-east-1
      const prov = atlas.traceEpisodeProvenance(synNode.id, { callerPrincipals: ["owner:M"] });
      expect(prov.allowed).toBe(true);
      expect(prov.episodeNodes.some((n) => n.id === "ep:turn-east-1")).toBe(true);

      // Conflicted clusters did NOT crystallize, and emitted 2 disambiguation cards
      expect(atlas.getNode("syn:domain_work:contract-guard:zhang-payment")).toBeUndefined();
      expect(atlas.getNode("syn:meta_evolution:release-branch")).toBeUndefined();
      expect(sleep.disambiguationCards).toHaveLength(2);
      expect(sleep.disambiguationCards.some((c) => c.topicKey === "zhang-payment" && c.conflictReason.includes("30天 vs 60天"))).toBe(true);
      expect(sleep.disambiguationCards.some((c) => c.topicKey === "release-branch" && c.conflictReason.includes("直推"))).toBe(true);

      // >7d unconfirmed sandbox expired in both mindLoop and Atlas; <7d fresh sandbox survived
      expect(sleep.expiredSandboxIds).toContain(staleHyp.id);
      expect(sleep.expiredSandboxIds).not.toContain(freshHyp.id);
      expect(mindLoop.listEntries().find((e) => e.id === staleHyp.id)?.status).toBe("superseded");
      expect(mindLoop.listEntries().find((e) => e.id === staleHyp.id)?.evidenceNotes).toContain("expired_unconfirmed_7d");
      expect(atlas.getNode(staleHyp.id)?.archivedAt).toBe("2026-11-28T12:00:00Z");
      expect(atlas.getNode(freshHyp.id)?.archivedAt).toBeUndefined();

      // Both weak noise edge and orphan edge were archived, while healthy target self:canon:keep-alive remained active!
      expect(sleep.archivedNoiseEdgeIds).toHaveLength(2);
      const keepAlive = atlas.getNode("self:canon:keep-alive");
      expect(keepAlive?.supersededAt).toBeUndefined();
      expect(keepAlive?.archivedAt).toBeUndefined();

      // Persist in GardenerStateStore and verify roundtrip
      store.setState({
        updatedAtIso: "2026-11-28T12:00:00Z",
        lastRunAtIso: "2026-11-28T12:00:00Z",
        surpriseMomentum: cycle.driftReport.surpriseMomentum,
        pendingDisambiguationCards: sleep.disambiguationCards,
        lastSleepConsolidation: {
          triggered: sleep.triggered,
          triggerReason: sleep.triggerReason,
          crystallizedNodeIds: sleep.crystallizedNodes.map((n) => n.id),
          synthesizedEdgesCount: sleep.synthesizedEdgesCount,
          disambiguationCards: sleep.disambiguationCards,
          expiredSandboxIds: sleep.expiredSandboxIds,
          archivedNoiseEdgeIds: sleep.archivedNoiseEdgeIds,
        },
      });
      const reloadedStore = new GardenerStateStore(path.join(dir, "steward"));
      expect(reloadedStore.getState().pendingDisambiguationCards).toHaveLength(2);
      expect(reloadedStore.getState().lastSleepConsolidation?.crystallizedNodeIds).toEqual([synNode.id]);

      // 5c. Idempotency check on immediate re-run (weeklyCalibrationDue = true)
      const secondRun = runAtlasSleepConsolidation({
        atlas,
        mindLoop,
        nowIso: "2026-11-28T12:05:00Z",
        weeklyCalibrationDue: true,
      });
      expect(secondRun.triggered).toBe(true);
      expect(secondRun.triggerReason).toBe("weekly_calibration");
      expect(secondRun.crystallizedNodes).toHaveLength(0);
      expect(secondRun.synthesizedEdgesCount).toBe(0);

      // Direct unit check on detectPairwiseMemoryConflict for price floors & compatible multi-clause rules
      expect(
        detectPairwiseMemoryConflict(
          { name: "企业版报价红线", summary: "年度顾问底价 48万" },
          { name: "企业版报价调整", summary: "年度顾问底价 35万" },
        )?.kind,
      ).toBe("numeric");
      expect(
        detectPairwiseMemoryConflict(
          { name: "华东合同红线", summary: "华东合同严禁突破底价" },
          { name: "华东合同付款", summary: "华东合同允许分两期付款" },
          "华东合同",
        ),
      ).toBeNull();
    } finally {
      atlas.close();
    }
  });
});
