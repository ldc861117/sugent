import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KG_EXTRACTION_SYSTEM, SugentKnowledgeGraph, resolveActiveDshSkillDirs, sanitizeDshSkillName } from "../src/sugent/knowledge-graph.js";
import { ensureSelfEvolutionOverlay, installSelfDevSkill } from "../src/sugent/self-evolution.js";
import {
  GardenerStateStore,
  applyGardenerEffects,
  deriveGardenerHypotheses,
  runGardenerCycle,
  type GardenerSandboxHypothesis,
} from "../src/sugent/memory-gardener.js";
import { PostTurnDigester } from "../src/sugent/post-turn-digester.js";
import { GroupChatScribe } from "../src/sugent/group-chat-scribe.js";
import { ConciergeChannelBridge } from "../src/sugent/concierge-channel-bridge.js";
import { StewardshipLedger } from "../src/sugent/stewardship-ledger.js";
import { REVIEW_SYSTEM } from "../src/agent/steward.js";

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("Wave P4 Tier-1 Lane A — KnowledgeGraph, SelfEvolution, Gardener, PostTurn, Scribe, Concierge", () => {
  it("1. KG: sanitizeDshSkillName, YAML-safe description, orphan mem archiving, ranked/capped recallSubgraph, and resolveActiveDshSkillDirs", () => {
    expect(sanitizeDshSkillName("wf:upstream-sync")).toBe("wf-upstream-sync");
    expect(sanitizeDshSkillName("wf:deploy-14")).toBe("wf-deploy-14");
    const hash8 = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 8);
    expect(sanitizeDshSkillName("mem:general:部署流程")).toBe(`mem-general-${hash8("mem:general:部署流程")}`);
    expect(sanitizeDshSkillName("部署流程")).toBe(`skill-${hash8("部署流程")}`);
    expect(sanitizeDshSkillName("wf:部署")).toBe(`wf-${hash8("wf:部署")}`);

    const dir = mkTmp("sugent-p4-kg-");
    const kg = new SugentKnowledgeGraph(path.join(dir, "kg"));
    kg.applyDelta(
      {
        nodes: [
          {
            id: "wf:部署",
            kind: "workflow",
            name: "中文部署",
            summary: "步骤: 运行 #verify [prod] 并确认",
            tags: ["deploy"],
            reinforcements: 3,
            steps: ["npm run verify:sugent"],
          },
        ],
      },
      "2026-11-28T00:00:00Z",
    );
    const skills = kg.crystallizeSkills(3);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.skillName).toBe(`wf-${hash8("wf:部署")}`);
    expect(skills[0]!.markdown).toContain(`description: ${JSON.stringify("步骤: 运行 #verify [prod] 并确认")}`);
    expect(kg.listSkillCandidates({ threshold: 3 })[0]!.skillName).toBe(skills[0]!.skillName);

    kg.ingestMemoryReviewOps({ add: [{ text: "测试记忆将要被删除", topic: "ops" }], remove: [] }, "b1", "2026-11-28T01:00:00Z");
    const memNode = kg.allNodes().find((n) => n.id.startsWith("mem:ops:"));
    expect(memNode).toBeTruthy();
    kg.ingestMemoryReviewOps({ add: [], remove: ["测试记忆将要被删除"] }, "b1", "2026-11-28T02:00:00Z");
    expect(kg.getNode(memNode!.id)?.supersededAt).toBe("2026-11-28T02:00:00Z");
    expect(kg.recallSubgraph("测试记忆", 2).matchedNodes.some((n) => n.id === memNode!.id)).toBe(false);

    kg.applyDelta({
      nodes: Array.from({ length: 25 }, (_, i) => ({
        id: `c:item-${i}`,
        kind: "concept" as const,
        name: `项目节点 ${i}`,
        summary: i === 24 ? "项目部署发布重点" : `普通记录 ${i}`,
        tags: [],
        reinforcements: i === 24 ? 5 : 1,
      })),
    });
    expect(kg.recallSubgraph("", 2).matchedNodes).toHaveLength(20);
    expect(kg.recallSubgraph("", 2, 500).matchedNodes.length).toBeGreaterThanOrEqual(25);
    expect(kg.recallSubgraph("我在", 2).matchedNodes).toHaveLength(0);
    const ranked = kg.recallSubgraph("项目 部署 发布", 2);
    expect(ranked.matchedNodes[0]!.id).toBe("c:item-24");

    expect(kg.archiveNode("c:item-0", "2026-11-28T03:00:00Z")).toBe(true);
    expect(kg.getNode("c:item-0")?.supersededAt).toBe("2026-11-28T03:00:00Z");

    const baseDirs = resolveActiveDshSkillDirs(dir, ["botA", "botA"]);
    expect(baseDirs).toEqual([path.join(dir, "dsh", "botA", "skills"), path.join(dir, "skills")]);
    fs.mkdirSync(path.join(dir, "self-repo", "extensions"), { recursive: true });
    expect(resolveActiveDshSkillDirs(dir, ["botA"])).toContain(path.join(dir, "self-repo", "extensions", ".dsh", "skills"));
  });

  it("2. SelfEvolution: mirrors ./skills/<name>/SKILL.md into <overlayDir>/.dsh/skills/<name>/SKILL.md", () => {
    const dir = mkTmp("sugent-p4-selfevo-");
    const overlayDir = ensureSelfEvolutionOverlay(dir, path.join(dir, "app.asar"));
    const customSkillDir = path.join(overlayDir, "skills", "custom-ops");
    fs.mkdirSync(customSkillDir, { recursive: true });
    fs.writeFileSync(path.join(customSkillDir, "SKILL.md"), "---\nname: custom-ops\ndescription: custom\n---\n# Custom\n");

    ensureSelfEvolutionOverlay(dir, path.join(dir, "app.asar"));
    expect(fs.existsSync(path.join(overlayDir, ".dsh", "skills", "sugent-self-dev", "SKILL.md"))).toBe(true);
    expect(fs.readFileSync(path.join(overlayDir, ".dsh", "skills", "custom-ops", "SKILL.md"), "utf8")).toContain("Custom");

    installSelfDevSkill(path.join(overlayDir, "skills"));
    expect(fs.existsSync(path.join(overlayDir, ".dsh", "skills", "sugent-self-dev", "SKILL.md"))).toBe(true);
  });

  it("3. MemoryGardener: populates kgPruningDelta, persists GardenerStateStore(0o600), derives hypotheses, and applies effects", () => {
    const dir = mkTmp("sugent-p4-gardener-");
    const stewardDir = path.join(dir, "sugent-stewardship");
    const kg = new SugentKnowledgeGraph(path.join(dir, "kg"));
    const ledger = new StewardshipLedger({ dataDir: dir, knowledgeGraph: kg });
    const goal = ledger.upsertGoal({ id: "g-1", partition: "work_project", title: "Core Goal", northStarCriterion: "Ship P4" });
    ledger.upsertRelationship({ id: "rel-zhang", partition: "work_project", name: "张总", preferences: ["先发结论"] });

    kg.applyDelta(
      {
        nodes: [
          { id: "a", kind: "concept", name: "A", summary: "A", tags: [] },
          { id: "b", kind: "concept", name: "B", summary: "B", tags: [] },
        ],
        edges: [{ from: "a", relation: "rel", to: "b", weight: 0.1, source: "old" }],
      },
      "2026-10-01T00:00:00Z",
    );

    const store = new GardenerStateStore(stewardDir);
    expect(store.getHypotheses()).toEqual([]);

    const recentRounds = [
      { roundId: "r1", title: "misc-1", status: "failed" as const, startedAt: "2026-11-27T00:00:00Z", updatedAt: "2026-11-27T00:01:00Z", hopCount: 1, ruleId: "rule-flaky", approvals: [], totalCostUsd: 0.1, facts: [] },
      { roundId: "r2", title: "misc-2", status: "failed" as const, startedAt: "2026-11-27T01:00:00Z", updatedAt: "2026-11-27T01:01:00Z", hopCount: 1, ruleId: "rule-flaky", approvals: [], totalCostUsd: 0.1, facts: [] },
      { roundId: "r3", title: "on-goal", status: "completed" as const, startedAt: "2026-11-27T02:00:00Z", updatedAt: "2026-11-27T02:01:00Z", hopCount: 1, goalId: goal.id, approvals: [], totalCostUsd: 0.1, facts: [] },
    ];
    const derived = deriveGardenerHypotheses({
      existing: [],
      ledger: ledger.snapshotForCaller("owner_private"),
      recentRounds,
      unapprovedWorkflows: [{ id: "wf:ci", name: "CI Flow", reinforcements: 2 }],
      nowIso: "2026-11-27T10:00:00Z",
    });
    expect(derived.some((h) => h.targetKind === "goal_drift_alert")).toBe(true);
    expect(derived.some((h) => h.targetKind === "skill_proposal")).toBe(true);
    expect(derived.some((h) => h.targetKind === "rule_demotion")).toBe(true);

    const tombstoneHyp: GardenerSandboxHypothesis = {
      id: "hyp-tomb-1",
      partition: "work_project",
      targetKind: "tombstone",
      statement: "禁止跳过类型检查",
      state: "PROPOSED",
      confidence: 0.74,
      confirmations: 2,
      contradictions: 0,
      createdAtIso: "2026-11-20T00:00:00Z",
      lastEvidenceAtIso: "2026-11-26T00:00:00Z",
    };

    const cycle = runGardenerCycle({
      nowIso: "2026-11-28T00:00:00Z",
      ledger: ledger.snapshotForCaller("owner_private"),
      recentRounds,
      hypotheses: [...derived, tombstoneHyp],
      sandboxEvents: { "hyp-tomb-1": "confirm" },
      activeEdges: kg.activeEdges(),
      ruleStats: [{ ruleId: "rule-flaky", mode: "act", emaEffectiveness: 0.1 }],
      recentMessagesByPeer: { "rel-zhang": { partition: "work_project", messages: ["您好，请查收。"] } },
      prevSurpriseMomentum: 0.4,
      maxStewardTokenBudget: 500,
    });
    expect(cycle.pruneEdgeIds).toEqual(["a--rel-->b"]);
    expect(cycle.kgPruningDelta.edges).toHaveLength(1);

    const demoted: string[] = [];
    const effects = applyGardenerEffects(cycle, {
      knowledgeGraph: kg,
      ledger,
      onDemoteRule: (id) => demoted.push(id),
      nowIso: "2026-11-28T00:00:00Z",
    });
    expect(effects).toEqual({ prunedEdges: 1, updatedRelationships: 1, writtenTombstones: 1, demotedRules: 1 });
    expect(demoted).toEqual(["rule-flaky"]);
    expect(kg.activeEdges().some((e) => e.id === "a--rel-->b")).toBe(false);
    expect(ledger.snapshotForCaller("owner_private").guardrails.some((g) => g.kind === "tombstone" && g.statement === "禁止跳过类型检查")).toBe(true);
    expect(ledger.snapshotForCaller("owner_private").relationships[0]!.preferences.length).toBeGreaterThanOrEqual(2);

    store.setState({ surpriseMomentum: cycle.driftReport.surpriseMomentum, lastRunAtIso: "2026-11-28T00:00:00Z", hypotheses: cycle.nextHypotheses, lastReport: cycle.driftReport, lastCalibrationLines: cycle.calibrationCardLines });
    expect(fs.statSync(store.filePath).mode & 0o777).toBe(0o600);
    const reloaded = new GardenerStateStore(stewardDir);
    expect(reloaded.getHypotheses().length).toBe(cycle.nextHypotheses.length);
  });

  it("4. PostTurnDigester: rejects secrets, runs offline directives & workflow reinforcement, optional LLM passes, and debounce/dispose", async () => {
    const dir = mkTmp("sugent-p4-postturn-");
    const kg = new SugentKnowledgeGraph(path.join(dir, "kg"));
    const ledger = new StewardshipLedger({ dataDir: dir, knowledgeGraph: kg });
    kg.applyDelta({
      nodes: [
        {
          id: "wf:release",
          kind: "workflow",
          name: "发版核查流程",
          summary: "先跑测试再打包",
          tags: ["release-check"],
          steps: ["npm test", "npm run build"],
        },
      ],
    });

    const synced: Array<{ text: string; topic?: string }> = [];
    const deltas: string[] = [];
    const digester = new PostTurnDigester({
      knowledgeGraph: kg,
      ledger,
      syncMemoryEntry: (text, topic) => synced.push({ text, topic }),
      onNodeDelta: (delta, ch) => deltas.push(`${ch}:${delta.nodes?.length ?? 0}`),
      debounceMs: 30,
      nowIso: () => "2026-11-28T05:00:00Z",
    });

    const secretRes = await digester.digestTurnNow({
      channel: "web",
      peerId: "owner",
      userText: "记住我的密钥是 sk-proj-1234567890abcdef123456",
      assistantReply: "好的",
    });
    expect(secretRes.skippedSecret).toBe(true);
    expect(synced).toHaveLength(0);

    const offlineRes = await digester.digestTurnNow({
      channel: "weixin",
      peerId: "owner",
      userText: "以后统一用 pnpm 安装依赖。切记不要跳过单测。另外今天已按发版核查流程完成验收。",
      assistantReply: "已按发版核查流程执行完毕",
    });
    expect(offlineRes.skippedSecret).toBe(false);
    expect(offlineRes.deterministicNodes).toBe(2);
    expect(offlineRes.deterministicReinforcedWorkflows).toBe(1);
    expect(kg.getNode("wf:release")?.reinforcements).toBe(2);
    expect(synced.some((s) => s.text.includes("pnpm"))).toBe(true);
    expect(deltas.length).toBeGreaterThanOrEqual(2);

    vi.stubEnv("SUGENT_KG_DEEP_EXTRACT", "1");
    const llmDigester = new PostTurnDigester({
      knowledgeGraph: kg,
      ledger,
      syncMemoryEntry: (text, topic) => synced.push({ text, topic }),
      completeFn: async (system) => {
        if (system === REVIEW_SYSTEM) {
          return JSON.stringify({ add: [{ text: "周报固定周五下午发", topic: "work" }], remove: [] });
        }
        if (system === KG_EXTRACTION_SYSTEM) {
          return JSON.stringify({
            nodes: [{ id: "proj:alpha", kind: "project", name: "Alpha", summary: "核心项目", tags: ["alpha"] }],
            edges: [],
          });
        }
        return "";
      },
    });
    const llmRes = await llmDigester.digestTurnNow({
      channel: "web",
      peerId: "owner",
      userText: "周报固定周五下午发",
      assistantReply: "记下了",
    });
    expect(llmRes.reviewAdded).toBe(1);
    expect(llmRes.deepExtractedNodes).toBe(1);
    expect(kg.getNode("proj:alpha")?.name).toBe("Alpha");

    digester.scheduleTurnDigest({
      channel: "web",
      peerId: "p-deb",
      userText: "我的偏好是先给结论",
      assistantReply: "收到",
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(synced.some((s) => s.text.includes("先给结论"))).toBe(true);
    digester.scheduleTurnDigest({
      channel: "web",
      peerId: "p-disp",
      userText: "记住这条会被清理",
      assistantReply: "收到",
    });
    digester.dispose();
    await new Promise((r) => setTimeout(r, 60));
    expect(synced.some((s) => s.text.includes("会被清理"))).toBe(false);
  });

  it("5a. GroupChatScribe.autoDistillReadyGroups respects count/age thresholds and skips duplicate pending_approval digests", async () => {
    const dir = mkTmp("sugent-p4-scribe-");
    const scribe = new GroupChatScribe({ dataDir: dir, whitelistedGroupIds: ["g-count", "g-age", "g-idle"] });
    for (let i = 1; i <= 3; i++) {
      scribe.recordGroupMessage({ groupId: "g-count", messageId: `c-${i}`, senderName: "李工", content: `进度更新 ${i}`, timestampIso: "2026-11-28T03:50:00Z" });
    }
    scribe.recordGroupMessage({ groupId: "g-age", messageId: "a-1", senderName: "张总", content: "我明天把合同发出来", timestampIso: "2026-11-28T00:30:00Z" });
    scribe.recordGroupMessage({ groupId: "g-idle", messageId: "i-1", senderName: "王工", content: "收到", timestampIso: "2026-11-28T03:55:00Z" });

    const nowMs = Date.parse("2026-11-28T04:00:00Z");
    const first = await scribe.autoDistillReadyGroups({ minUnarchivedCount: 3, maxAgeMs: 2 * 3600_000, nowMs });
    expect(first.map((d) => d.groupId).sort()).toEqual(["g-age", "g-count"]);

    const second = await scribe.autoDistillReadyGroups({ minUnarchivedCount: 3, maxAgeMs: 2 * 3600_000, nowMs });
    expect(second).toHaveLength(0);
  });

  it("5b. ConciergeChannelBridge avoids goal/cap false canary blocks, matches rel:* scopes, calls live assessor with ledger hints, and falls back on error", async () => {
    const dir = mkTmp("sugent-p4-concierge-");
    const kg = new SugentKnowledgeGraph(path.join(dir, "kg"));
    const ledger = new StewardshipLedger({ dataDir: dir, knowledgeGraph: kg });
    ledger.upsertGoal({ id: "goal-main", partition: "work_project", title: "排期", northStarCriterion: "交付" });
    ledger.upsertRelationship({ id: "wx_vip_1", partition: "work_project", name: "陈总", taboos: ["别提上季预算"], preferences: ["先给排期结论"] });

    const ownerNotes: string[] = [];
    const peerReplies: string[] = [];
    let shouldFailFetch = false;
    let capturedBody = "";
    const bridge = new ConciergeChannelBridge({
      dataDir: dir,
      knowledgeGraph: kg,
      ledger,
      resolveAssessorEndpoint: () => ({ baseUrl: "http://127.0.0.1:49999/v1", apiKey: "test-key", model: "steward-mini" }),
      fetchImpl: (async (_url, init) => {
        capturedBody = String(init?.body ?? "");
        if (shouldFailFetch) throw new Error("network down");
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ intentCategory: "general_inquiry", summary: "LIVE_ASSESS: 陈总询问排期", draftA: "已核对排期，下午发您。", draftB: "收到陈总，今天对齐细节。" }) } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
      resolveActorRole: ({ senderId }) => (senderId === "owner_1" ? "owner" : "external_peer"),
      defaultTransport: {
        notifyOwner: async (_ch, text) => { ownerNotes.push(text); },
        sendPeerDirectMessage: async (_ch, _peer, text) => { peerReplies.push(text); },
      },
    });
    bridge.updateConfig({ enabled: true, ownerDisplayName: "吕总", cloudMode: "byok_local", coolingWindowMs: 20 });

    const resLive = await bridge.processInboundEvent({
      id: "evt_live_1",
      channel: "weixin",
      botId: "default",
      conversation: { kind: "dm", id: "wx_vip_1" },
      sender: { id: "wx_vip_1", name: "陈总" },
      parts: [{ type: "text", text: "你好，咱们本周的排期能发我看下吗？" }],
      replyHandle: {},
      receivedAt: Date.now(),
    });
    expect(resLive.routeTaken).toBe("whisper_earpiece");
    expect(capturedBody).toContain("别提上季预算");
    expect(capturedBody).toContain("先给排期结论");
    expect(ownerNotes[0]).toContain("LIVE_ASSESS");

    const cardId = resLive.routeTaken === "whisper_earpiece" ? resLive.cardId : "";
    const confirmHash = ownerNotes[0]!.match(/\/send A \S+ ([a-f0-9]+)/)?.[1] ?? "";
    const cmdRes = await bridge.executeOwnerCommand(`/send A ${cardId} ${confirmHash}`, "weixin");
    expect(cmdRes.status).toBe("cooling_off_scheduled");
    await new Promise((r) => setTimeout(r, 40));
    expect(peerReplies).toHaveLength(1);
    expect(peerReplies[0]).toContain("排期");

    shouldFailFetch = true;
    await bridge.processInboundEvent({
      id: "evt_fallback_2",
      channel: "weixin",
      botId: "default",
      conversation: { kind: "dm", id: "wx_vip_1" },
      sender: { id: "wx_vip_1", name: "陈总" },
      parts: [{ type: "text", text: "想预约下周三会议演示" }],
      replyHandle: {},
      receivedAt: Date.now(),
    });
    expect(ownerNotes.at(-1)).toContain("客户来信要点");
  });
});
