import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findAppRoot } from "../src/magpie/supervisor.js";
import type { LedgerSnapshot } from "../src/sugent/stewardship-ledger.js";
import {
  DEFAULT_DAILY_NON_URGENT_QUOTA,
  collectGoalStagnationUnblock,
  collectRealtimeGoalDrift,
  createAttentionBudgetGate,
  createDefaultBudgetState,
  drainBoundaryQueue,
  evaluateFlowAwareDelivery,
  filterSupersededBeforeSend,
  gateProactiveCandidates,
  scanLedgerImbalances,
  snoozeProactiveTopic,
  type CadenceBudgetState,
  type CadenceBudgetStoragePort,
  type CadenceFleetPulseInput,
  type ProactiveCandidate,
} from "../src/sugent/proactive-cadence.js";

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-cadence-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeEmptyLedger(): LedgerSnapshot {
  return {
    version: 1,
    updatedAt: "2026-11-20T00:00:00.000Z",
    relationships: [],
    goals: [],
    guardrails: [],
    commitments: [],
    resources: [],
  };
}

describe("Bounded Proactive Cadence Purity Gate (proactive-cadence.ts)", () => {
  it("enforces zero fs/http/fetch/clock/random/vendor hardcoding across full source", () => {
    const filePath = path.join(findAppRoot(), "src", "sugent", "proactive-cadence.ts");
    const rawSource = fs.readFileSync(filePath, "utf8");
    const codeOnly = rawSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    const forbiddenApis = [
      /\bfetch\s*\(/,
      /\bnode:(?:fs|http|https|net|tls|child_process|dgram|dns)\b/,
      /\bDate\.now\s*\(/,
      /\bnew\s+Date\s*\(/,
      /\bMath\.random\s*\(/,
      /\bcrypto\.random/,
      /\bsetTimeout\s*\(/,
      /\bsetInterval\s*\(/,
    ];
    for (const pattern of forbiddenApis) {
      expect(rawSource, `Forbidden API ${pattern} in raw source`).not.toMatch(pattern);
      expect(codeOnly, `Forbidden API ${pattern} in executable code`).not.toMatch(pattern);
    }

    const forbiddenVendors = [
      /\bclaude\b/i, /\bcodex\b/i, /\bopenai\b/i, /\banthropic\b/i, /\bdeepseek\b/i,
      /\bgemini\b/i, /\bmodelflare\b/i, /\bfeishu\b/i, /\bweixin\b/i, /\bwechat\b/i,
      /\btelegram\b/i, /\bdiscord\b/i, /\bslack\b/i, /\blark\b/i, /\bdingtalk\b/i,
    ];
    for (const vendor of forbiddenVendors) {
      expect(rawSource, `Forbidden vendor/platform ${vendor}`).not.toMatch(vendor);
    }
  });
});

describe("scanLedgerImbalances (Ledger Signals & 3-Line Compression)", () => {
  const nowIso = "2026-11-20T09:00:00.000Z";

  it("stays completely silent when all ledger dimensions are healthy", () => {
    const ledger = makeEmptyLedger();
    ledger.goals.push(
      {
        id: "g-fresh",
        partition: "work_project",
        title: "交付 Sprint 2",
        northStarCriterion: "单测全绿",
        status: "active",
        lastProgressAt: "2026-11-18T09:00:00.000Z",
        stallThresholdDays: 7,
      },
      {
        id: "g-paused",
        partition: "personal_life",
        title: "已暂停目标",
        northStarCriterion: "不触发",
        status: "paused",
        lastProgressAt: "2026-10-01T00:00:00.000Z",
        stallThresholdDays: 3,
      },
    );
    ledger.commitments.push(
      {
        id: "c-far",
        partition: "work_project",
        direction: "i_owe",
        status: "open",
        summary: "远期任务",
        counterpartyOrRef: "partner-a",
        dueAt: "2026-11-30T09:00:00.000Z",
        remindLeadDays: 3,
        updatedAt: nowIso,
      },
      {
        id: "c-closed",
        partition: "work_project",
        direction: "i_owe",
        status: "closed",
        summary: "已完结任务",
        counterpartyOrRef: "partner-b",
        dueAt: "2026-11-10T09:00:00.000Z",
        updatedAt: nowIso,
      },
      {
        id: "c-snoozed",
        partition: "work_project",
        direction: "i_owe",
        status: "snoozed",
        summary: "已延后提醒事项",
        counterpartyOrRef: "partner-c",
        dueAt: "2026-11-10T09:00:00.000Z",
        updatedAt: nowIso,
      },
    );
    ledger.resources.push(
      {
        id: "r-closed",
        partition: "personal_life",
        kind: "personal_archive",
        title: "已续期证件",
        expiresAt: "2026-11-15T00:00:00.000Z",
        metadata: { closed: true },
      },
      {
        id: "r-window",
        partition: "work_project",
        kind: "time_window",
        title: "历史时间窗",
        expiresAt: "2026-11-15T00:00:00.000Z",
        metadata: {},
      },
    );

    expect(scanLedgerImbalances(ledger, nowIso)).toEqual([]);
  });

  it("detects stalled goals, expiring/overdue commitments & resources, waiting_review, and calibrationDue", () => {
    const ledger = makeEmptyLedger();
    ledger.goals.push({
      id: "g-stalled",
      partition: "work_project",
      title: "核心引擎\n重构",
      northStarCriterion: "完成端到端回归",
      status: "active",
      lastProgressAt: "2026-11-12T09:00:00.000Z",
      stallThresholdDays: 7,
    });
    ledger.commitments.push(
      {
        id: "c-soon",
        partition: "personal_life",
        direction: "expiring",
        status: "open",
        summary: "提交年度续保材料",
        counterpartyOrRef: "保险专员",
        dueAt: "2026-11-22T09:00:00.000Z",
        updatedAt: nowIso,
      },
      {
        id: "c-overdue",
        partition: "work_project",
        direction: "i_owe",
        status: "open",
        summary: "回传合同修订稿",
        counterpartyOrRef: "法务团队",
        dueAt: "2026-11-19T09:00:00.000Z",
        updatedAt: nowIso,
      },
      {
        id: "c-review",
        partition: "work_project",
        direction: "waiting_for",
        status: "waiting_review",
        summary: "Sprint 2 接口草案验收",
        counterpartyOrRef: "conv-101",
        updatedAt: nowIso,
      },
    );
    ledger.resources.push(
      {
        id: "r-archive",
        partition: "personal_life",
        kind: "personal_archive",
        title: "身份证件有效期",
        expiresAt: "2026-11-21T09:00:00.000Z",
        metadata: {},
      },
      {
        id: "r-budget",
        partition: "work_project",
        kind: "budget_cap",
        title: "月度算力额度上限",
        expiresAt: "2026-11-19T00:00:00.000Z",
        metadata: {},
      },
    );

    const candidates = scanLedgerImbalances(ledger, nowIso, { calibrationDue: true });
    expect(candidates.map((c) => c.kind).sort()).toEqual([
      "commitment_expiring",
      "commitment_expiring",
      "commitment_expiring",
      "commitment_expiring",
      "goal_imbalance",
      "periodic_calibration",
      "review_ready",
    ]);

    const overdueCommit = candidates.find((c) => c.targetRefId === "c-overdue");
    const soonCommit = candidates.find((c) => c.targetRefId === "c-soon");
    const soonArchive = candidates.find((c) => c.targetRefId === "r-archive");
    const overdueBudget = candidates.find((c) => c.targetRefId === "r-budget");
    expect(overdueCommit?.urgency).toBe("urgent");
    expect(soonCommit?.urgency).toBe("normal");
    expect(soonArchive?.urgency).toBe("normal");
    expect(overdueBudget?.urgency).toBe("urgent");

    for (const c of candidates) {
      expect(c.threeLineBody).toHaveLength(3);
      for (const line of c.threeLineBody) {
        expect(line).not.toMatch(/[\r\n]/);
        expect(line.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("scanLedgerImbalances (Fleet Pulses) & gateProactiveCandidates", () => {
  const nowIso = "2026-11-20T09:00:00.000Z";

  it("maps fleet pulses correctly and skips superseded entries", () => {
    const pulses: CadenceFleetPulseInput[] = [
      {
        id: "p-red",
        dedupeKey: "fleet:red:repo-a",
        kind: "red_collision",
        projectKey: "repo:org/alpha",
        nodeId: "node-mbp",
        summary: "两节点同时修改 src/index.ts",
        actionHint: "暂停其中一侧并对齐分支",
        urgency: "urgent",
        conversationId: "conv-red-1",
        updatedAtIso: nowIso,
      },
      {
        id: "p-err",
        dedupeKey: "fleet:err:node-b",
        kind: "node_or_sidecar_error",
        projectKey: "repo:org/beta",
        nodeId: "node-mini",
        summary: "sidecar 心跳超时",
        actionHint: "检查本地守护进程日志",
        urgency: "urgent",
        updatedAtIso: nowIso,
      },
      {
        id: "p-handoff",
        dedupeKey: "fleet:handoff:1",
        kind: "pending_handoff",
        projectKey: "repo:org/alpha",
        nodeId: "node-mbp",
        summary: "待认领测试收尾",
        actionHint: "查看交接卡并确认",
        urgency: "normal",
        updatedAtIso: nowIso,
      },
      {
        id: "p-rev",
        dedupeKey: "fleet:review:1",
        kind: "review_ready",
        projectKey: "repo:org/gamma",
        nodeId: "node-mbp",
        summary: "重构方案等待拍板",
        actionHint: "回复 1 放行",
        urgency: "normal",
        conversationId: "conv-rev-1",
        updatedAtIso: nowIso,
      },
      {
        id: "p-sup",
        dedupeKey: "fleet:superseded",
        kind: "red_collision",
        projectKey: "repo:org/alpha",
        nodeId: "node-mbp",
        summary: "已被本地消除的告警",
        actionHint: "忽略",
        urgency: "urgent",
        superseded: true,
        updatedAtIso: nowIso,
      },
    ];

    const candidates = scanLedgerImbalances(makeEmptyLedger(), nowIso, { fleetPulses: pulses });
    expect(candidates).toHaveLength(4);
    expect(candidates.find((c) => c.dedupeKey === "fleet:superseded")).toBeUndefined();

    const red = candidates.find((c) => c.dedupeKey === "fleet:red:repo-a");
    const err = candidates.find((c) => c.dedupeKey === "fleet:err:node-b");
    const handoff = candidates.find((c) => c.dedupeKey === "fleet:handoff:1");
    const rev = candidates.find((c) => c.dedupeKey === "fleet:review:1");
    expect(red).toMatchObject({ kind: "fleet_collision_or_alert", urgency: "urgent", targetRefId: "conv-red-1" });
    expect(err).toMatchObject({ kind: "fleet_collision_or_alert", urgency: "urgent" });
    expect(handoff).toMatchObject({ kind: "fleet_collision_or_alert", urgency: "normal" });
    expect(rev).toMatchObject({ kind: "review_ready", urgency: "normal", targetRefId: "conv-rev-1" });
  });
});

describe("gateProactiveCandidates (Daily Soft Quota <= 2, Quiet Hours & Urgent Bypass)", () => {
  const mkCandidate = (
    id: string,
    urgency: "normal" | "urgent" = "normal",
    dedupeKey = `key:${id}`,
    kind: ProactiveCandidate["kind"] = urgency === "urgent" ? "fleet_collision_or_alert" : "goal_imbalance",
  ): ProactiveCandidate => ({
    candidateId: id,
    dedupeKey,
    kind,
    urgency,
    title: `Title ${id}`,
    threeLineBody: [`L1 ${id}`, `L2 ${id}`, `L3 ${id}`],
    targetRefId: `ref-${id}`,
  });

  it("allows unbounded emissions when DEFAULT_DAILY_NON_URGENT_QUOTA is 0 and enforces explicit numeric cap when set", () => {
    const initial = createDefaultBudgetState("2026-11-20");
    expect(DEFAULT_DAILY_NON_URGENT_QUOTA).toBe(0);
    expect(initial.dailySoftQuota).toBe(0);

    const batch = [
      mkCandidate("c1"),
      mkCandidate("c2"),
      mkCandidate("c3"),
      mkCandidate("c3-dup", "normal", "key:c3"),
      mkCandidate("c4"),
    ];
    const unbounded = gateProactiveCandidates(batch, initial);
    expect(unbounded.emitNow.map((c) => c.candidateId)).toEqual(["c1", "c2", "c3", "c4"]);
    expect(unbounded.foldToMorningDigest).toEqual([]);
    expect(unbounded.suppressedIds).toEqual(["c3-dup"]);

    const cappedInit = createDefaultBudgetState("2026-11-20", 2);
    const gated = gateProactiveCandidates(batch, cappedInit);
    expect(gated.emitNow.map((c) => c.candidateId)).toEqual(["c1", "c2"]);
    expect(gated.foldToMorningDigest.map((c) => c.candidateId)).toEqual(["c3", "c4"]);
    expect(gated.suppressedIds).toEqual(["c3-dup"]);
    expect(gated.nextState.nonUrgentSentCount).toBe(2);
    expect(gated.nextState.morningDigestQueue.map((c) => c.candidateId)).toEqual(["c3", "c4"]);
    expect(cappedInit.nonUrgentSentCount).toBe(0);
  });

  it("folds all non-urgent items during quiet hours while letting urgent RED/error alerts pass with dedupe", () => {
    const quietBudget = createDefaultBudgetState("2026-11-20", 2, true);
    const batch = [
      mkCandidate("n1", "normal"),
      mkCandidate("n2", "normal"),
      mkCandidate("red1", "urgent", "fleet:red:1"),
      mkCandidate("red1-same-batch-dup", "urgent", "fleet:red:1"),
      mkCandidate("err1", "urgent", "fleet:err:1"),
    ];

    const first = gateProactiveCandidates(batch, quietBudget);
    expect(first.emitNow.map((c) => c.candidateId)).toEqual(["red1", "err1"]);
    expect(first.foldToMorningDigest.map((c) => c.candidateId)).toEqual(["n1", "n2"]);
    expect(first.suppressedIds).toEqual(["red1-same-batch-dup"]);
    expect(first.nextState.nonUrgentSentCount).toBe(0);
    expect(first.nextState.morningDigestQueue.map((c) => c.candidateId)).toEqual(["n1", "n2"]);

    // 同一天再次扫描到已发过的 urgent（fleet:red:1）及已折叠过的 n1：urgent 应被去重抑制，队列不重复膨胀
    const second = gateProactiveCandidates(
      [mkCandidate("red1-repeat", "urgent", "fleet:red:1"), mkCandidate("n1-repeat", "normal", "key:n1")],
      first.nextState,
    );
    expect(second.emitNow).toEqual([]);
    expect(second.suppressedIds).toEqual(["red1-repeat"]);
    expect(second.nextState.morningDigestQueue).toHaveLength(2);
  });
});

describe("filterSupersededBeforeSend, Cross-Day Rollover & drainMorningDigest", () => {
  const mkCandidate = (id: string, refId: string): ProactiveCandidate => ({
    candidateId: id,
    dedupeKey: `dedupe:${id}`,
    kind: "review_ready",
    urgency: "normal",
    title: `Review ${id}`,
    threeLineBody: [`L1 ${id}`, `L2 ${refId}`, "L3 reply"],
    targetRefId: refId,
  });

  it("filters superseded candidates right before send", () => {
    const c1 = mkCandidate("c1", "conv-1");
    const c2 = mkCandidate("c2", "conv-2");
    const { deliverable, supersededIds } = filterSupersededBeforeSend([c1, c2], (c) => c.targetRefId === "conv-1");
    expect(supersededIds).toEqual(["c1"]);
    expect(deliverable.map((c) => c.candidateId)).toEqual(["c2"]);
  });

  it("supports memory-only mode and injected storagePort across cross-day rollover and morning drain", () => {
    const memGate = createAttentionBudgetGate();
    const m1 = memGate.evaluateAndRecord([mkCandidate("m1", "ref-1")], "2026-11-20", false);
    expect(m1.emitNow).toHaveLength(1);
    expect(memGate.getState("2026-11-20").nonUrgentSentCount).toBe(1);

    const budgetFile = path.join(makeTempDir(), "cadence-budget.json");
    const storagePort: CadenceBudgetStoragePort = {
      load() {
        if (!fs.existsSync(budgetFile)) return undefined;
        return JSON.parse(fs.readFileSync(budgetFile, "utf8")) as CadenceBudgetState;
      },
      save(state) {
        fs.writeFileSync(budgetFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      },
    };

    const gateDay1 = createAttentionBudgetGate(storagePort, 2);
    const d1Daytime = gateDay1.evaluateAndRecord(
      [mkCandidate("d1", "conv-d1"), mkCandidate("d2", "conv-d2"), mkCandidate("d3-fold", "conv-d3")],
      "2026-11-20",
      false,
    );
    expect(d1Daytime.emitNow.map((c) => c.candidateId)).toEqual(["d1", "d2"]);
    expect(d1Daytime.foldToMorningDigest.map((c) => c.candidateId)).toEqual(["d3-fold"]);

    const d1Quiet = gateDay1.evaluateAndRecord([mkCandidate("d4-quiet", "conv-d4")], "2026-11-20", true);
    expect(d1Quiet.foldToMorningDigest.map((c) => c.candidateId)).toEqual(["d4-quiet"]);

    // 模拟进程重启并跨天到 2026-11-21：每日计数与已发去重表清零，但 morningDigestQueue 保留
    const gateDay2 = createAttentionBudgetGate(storagePort, 2);
    const day2Start = gateDay2.getState("2026-11-21");
    expect(day2Start.dateKey).toBe("2026-11-21");
    expect(day2Start.nonUrgentSentCount).toBe(0);
    expect(day2Start.sentDedupeKeys).toEqual([]);
    expect(day2Start.morningDigestQueue.map((c) => c.candidateId)).toEqual(["d3-fold", "d4-quiet"]);

    // 早间发送前二次销账：假设 conv-d3 昨夜已在本地 IDE 推进，仅放行 d4-quiet
    const drained = gateDay2.drainMorningDigest("2026-11-21", (c) => c.targetRefId === "conv-d3");
    expect(drained.supersededIds).toEqual(["d3-fold"]);
    expect(drained.emitNow.map((c) => c.candidateId)).toEqual(["d4-quiet"]);
    expect(drained.state.morningDigestQueue).toEqual([]);
    expect(drained.state.sentDedupeKeys).toContain("dedupe:d4-quiet");

    // 当天再次评估已通过早间简报发出的 d4-quiet 应被去重抑制，同时仍保留日间配额
    const day2Follow = gateDay2.evaluateAndRecord(
      [mkCandidate("d4-quiet", "conv-d4"), mkCandidate("d5-new", "conv-d5")],
      "2026-11-21",
      false,
    );
    expect(day2Follow.suppressedIds).toEqual(["d4-quiet"]);
    expect(day2Follow.emitNow.map((c) => c.candidateId)).toEqual(["d5-new"]);
    expect(day2Follow.state.nonUrgentSentCount).toBe(1);
  });
});

describe("Flow-Aware Boundary Delivery, Topic Cooldown, Hour Drift & Stagnation Unblock", () => {
  const mk = (id: string, refId: string, urgency: "normal" | "urgent" = "normal"): ProactiveCandidate => ({
    candidateId: id,
    dedupeKey: `k:${id}`,
    kind: "review_ready",
    urgency,
    title: `T ${id}`,
    threeLineBody: ["L1", "L2", "L3"],
    targetRefId: refId,
  });

  it("allows unbounded co-working, holds off-goal items at boundary during deep focus, and respects cooldown", () => {
    const base = createDefaultBudgetState("2026-11-21");
    const coRes = evaluateFlowAwareDelivery(
      [mk("c1", "g1"), mk("c2", "g1"), mk("c3", "g1"), mk("c4", "g1")],
      base,
      { mode: "co_working", activeGoalId: "g1" },
      "2026-11-21T10:00:00Z",
    );
    expect(coRes.emitNow).toHaveLength(4);

    const deepRes = evaluateFlowAwareDelivery(
      [mk("on-goal", "g1"), mk("off-goal", "g2"), mk("urgent-alert", "g3", "urgent")],
      base,
      { mode: "deep_focus", activeGoalId: "g1", flowStrength: 0.85 },
      "2026-11-21T10:00:00Z",
    );
    expect(deepRes.emitNow.map((c) => c.candidateId)).toEqual(["urgent-alert", "on-goal"]);
    expect(deepRes.holdForBoundary.map((c) => c.candidateId)).toEqual(["off-goal"]);
    expect(deepRes.nextState.boundaryQueue?.map((c) => c.candidateId)).toEqual(["off-goal"]);

    const drained = drainBoundaryQueue(deepRes.nextState, () => false);
    expect(drained.emitNow.map((c) => c.candidateId)).toEqual(["off-goal"]);
    expect(drained.nextState.boundaryQueue).toEqual([]);

    const snoozed = snoozeProactiveTopic(base, "k:off-goal", "2026-11-21T15:00:00Z");
    const blocked = evaluateFlowAwareDelivery(
      [mk("off-goal", "g2")],
      snoozed,
      { mode: "idle_or_boundary" },
      "2026-11-21T12:00:00Z",
    );
    expect(blocked.emitNow).toEqual([]);
    expect(blocked.suppressedIds).toEqual(["off-goal"]);
  });

  it("triggers hour-level goal drift and 3-turn stagnation micro-step unblocking", () => {
    const ledger = makeEmptyLedger();
    ledger.goals.push({
      id: "g-main",
      partition: "work_project",
      title: "上线商业版计费",
      northStarCriterion: "跑通首单支付闭环",
      status: "active",
      targetDateIso: "2026-11-23T18:00:00Z",
      lastProgressAt: "2026-11-20T09:00:00Z",
      stallThresholdDays: 7,
    });
    const drift = collectRealtimeGoalDrift(
      ledger,
      { offGoalMinutesToday: 210, sideTaskLabel: "折腾旧脚本" },
      "2026-11-21T16:00:00Z",
    );
    expect(drift).toHaveLength(1);
    expect(drift[0]!.threeLineBody[0]).toContain("3.5 小时");

    const unblock = collectGoalStagnationUnblock(
      ledger,
      { "g-main": [{ status: "completed", informationGain: 0.08 }, { status: "failed" }, { status: "completed", informationGain: 0.1 }] },
      "2026-11-21T16:00:00Z",
    );
    expect(unblock).toHaveLength(1);
    expect(unblock[0]!.kind).toBe("goal_unblock");
  });
});