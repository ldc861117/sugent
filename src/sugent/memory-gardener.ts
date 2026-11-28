/**
 * 离线记忆园丁与认知对齐巡检引擎（src/sugent/memory-gardener.ts）
 *
 * 严格遵循「闲时不空转，仅在周度校准或 Titans 意外度动量 >= 0.7 时触发」原则：
 * 1. Goal-vs-Action 偏航审计：统计非主目标工作占比并生成周期算账提示；
 * 2. DreamSandbox 假说沙盒：PROPOSED (0.3) -> 3 次现实印证转正，2 次驳回或超 7 天过期淘汰；
 * 3. Titans 意外度动量与 AdaptiveCoherentizer 三档成本控制（<0.2 / 0.2-0.5 / >=0.5）；
 * 4. LanguageProfiler 零 LLM 软品味提取与 MergeGuard（>= 2 强证据）跨端合号门禁。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RoundTraceProjection } from "./causal-ledger.js";
import type { KGDelta, KGEdge, SugentKnowledgeGraph } from "./knowledge-graph.js";
import type { ContextPartition, LedgerSnapshot, StewardshipLedger } from "./stewardship-ledger.js";

export const URGENT_SURPRISE_THRESHOLD = 0.7;
export const SANDBOX_INITIAL_CONFIDENCE = 0.3;
export const SANDBOX_VALIDATION_THRESHOLD = 3;
export const SANDBOX_MAX_CONTRADICTIONS = 2;
export const SANDBOX_EXPIRY_DAYS = 7;

export type GardenerCostTier = "tier0_deterministic" | "tier1_template" | "tier2_steward_llm";
export type HypothesisState = "PROPOSED" | "VALIDATED" | "DISCARDED";

export interface GardenerSandboxHypothesis {
  id: string;
  partition: ContextPartition;
  targetKind: "tombstone" | "skill_proposal" | "rule_demotion" | "goal_drift_alert";
  statement: string;
  state: HypothesisState;
  confidence: number;
  confirmations: number;
  contradictions: number;
  createdAtIso: string;
  lastEvidenceAtIso: string;
}

export interface GoalActionDriftReport {
  windowDays: number;
  activeGoalIds: string[];
  nonGoalRoundShare: number;
  nonGoalCostShare: number;
  surpriseMomentum: number;
  urgentTriggered: boolean;
}

export interface LanguageTasteDelta {
  relationshipId: string;
  partition: ContextPartition;
  avgCharsEma: number;
  formalityScore: number;
  suggestedPreferences: string[];
}

export interface ContactIdentitySample {
  channel: string;
  displayName?: string;
  phone?: string;
  email?: string;
  verifiedHandle?: string;
  externalPeerId?: string;
}

export interface MergeGuardResult {
  canMerge: boolean;
  strongMatchCount: number;
  matchedStrongFields: string[];
  weakOnlyMatches: string[];
  reason: string;
}

export interface RuleEmaSample {
  ruleId: string;
  mode: "observe" | "act";
  emaEffectiveness: number;
}

export interface GardenerCycleInput {
  nowIso: string;
  ledger: LedgerSnapshot;
  recentRounds: RoundTraceProjection[];
  hypotheses: GardenerSandboxHypothesis[];
  sandboxEvents?: Record<string, "confirm" | "contradict">;
  activeEdges?: KGEdge[];
  ruleStats?: RuleEmaSample[];
  recentMessagesByPeer?: Record<string, { partition: ContextPartition; messages: string[] }>;
  prevSurpriseMomentum: number;
  currentSurprise?: number;
  maxStewardTokenBudget: number;
  windowDays?: number;
}

export interface GardenerCycleOutput {
  costTier: GardenerCostTier;
  tokenBudgetApplied: number;
  driftReport: GoalActionDriftReport;
  nextHypotheses: GardenerSandboxHypothesis[];
  promotedProposals: GardenerSandboxHypothesis[];
  discardedProposalIds: string[];
  demotedRuleIds: string[];
  tasteUpdates: LanguageTasteDelta[];
  pruneEdgeIds: string[];
  kgPruningDelta: KGDelta;
  calibrationCardLines: [string, string, string];
}

const MS_PER_DAY = 86_400_000;

export function computeSurpriseMomentum(prevMomentum: number, currentSurprise: number, eta = 0.7): number {
  const p = Number.isFinite(prevMomentum) ? Math.max(0, Math.min(1, prevMomentum)) : 0;
  const c = Number.isFinite(currentSurprise) ? Math.max(0, Math.min(1, currentSurprise)) : 0;
  return Math.round((eta * p + (1 - eta) * c) * 10000) / 10000;
}

export function selectGardenerCostTier(salience: number): GardenerCostTier {
  if (salience < 0.2) return "tier0_deterministic";
  if (salience < 0.5) return "tier1_template";
  return "tier2_steward_llm";
}

export function advanceSandboxHypothesis(
  hypothesis: GardenerSandboxHypothesis,
  event: "confirm" | "contradict" | undefined,
  nowIso: string,
): GardenerSandboxHypothesis {
  if (hypothesis.state !== "PROPOSED") return { ...hypothesis };
  let confirmations = hypothesis.confirmations;
  let contradictions = hypothesis.contradictions;
  let lastEvidenceAtIso = hypothesis.lastEvidenceAtIso;
  let confidence = hypothesis.confidence;

  if (event === "confirm") {
    confirmations += 1;
    confidence = Math.min(0.95, Math.round((confidence + 0.22) * 100) / 100);
    lastEvidenceAtIso = nowIso;
  } else if (event === "contradict") {
    contradictions += 1;
    confidence = Math.max(0.05, Math.round((confidence - 0.15) * 100) / 100);
    lastEvidenceAtIso = nowIso;
  }

  let state: HypothesisState = "PROPOSED";
  if (confirmations >= SANDBOX_VALIDATION_THRESHOLD) {
    state = "VALIDATED";
  } else if (contradictions >= SANDBOX_MAX_CONTRADICTIONS) {
    state = "DISCARDED";
  } else {
    const lastMs = Date.parse(lastEvidenceAtIso);
    const nowMs = Date.parse(nowIso);
    if (Number.isFinite(lastMs) && Number.isFinite(nowMs) && (nowMs - lastMs) / MS_PER_DAY >= SANDBOX_EXPIRY_DAYS) {
      state = "DISCARDED";
    }
  }
  return { ...hypothesis, confirmations, contradictions, confidence, lastEvidenceAtIso, state };
}

export function profilePeerLanguage(
  relationshipId: string,
  partition: ContextPartition,
  messages: readonly string[],
): LanguageTasteDelta | undefined {
  const clean = messages.map((m) => String(m ?? "").trim()).filter(Boolean);
  if (clean.length === 0) return undefined;
  const avgCharsEma = Math.round((clean.reduce((acc, m) => acc + m.length, 0) / clean.length) * 10) / 10;
  let formalHits = 0;
  let casualHits = 0;
  for (const m of clean) {
    if (/(?:您好|烦请|麻烦|附件|汇报|确认|请查收|感谢|敬请|Dear|Regards)/i.test(m)) formalHits++;
    if (/(?:哈哈|嗯嗯|好的呀|ok|👌|😄|🙏|咱|啥|咋)/i.test(m)) casualHits++;
  }
  const formalityScore = Math.max(0, Math.min(1, Math.round((0.5 + (formalHits - casualHits) / (clean.length * 2)) * 100) / 100));
  const suggestedPreferences: string[] = [];
  if (avgCharsEma <= 45) suggestedPreferences.push("偏好短句直给结论（不超过3行）");
  else if (avgCharsEma >= 140) suggestedPreferences.push("接受展开交代前因后果与依据");
  if (formalityScore >= 0.65) suggestedPreferences.push("沟通保持正式克制敬语");
  else if (formalityScore <= 0.35) suggestedPreferences.push("日常口语直白沟通即可");
  return { relationshipId, partition, avgCharsEma, formalityScore, suggestedPreferences };
}

export function canMergeContactIdentities(a: ContactIdentitySample, b: ContactIdentitySample): MergeGuardResult {
  const norm = (v: string | undefined): string => String(v ?? "").trim().toLowerCase();
  const strongFields: Array<keyof ContactIdentitySample> = ["phone", "email", "verifiedHandle", "externalPeerId"];
  const matchedStrongFields: string[] = [];
  for (const field of strongFields) {
    const va = norm(a[field]);
    const vb = norm(b[field]);
    if (va && vb && va === vb) matchedStrongFields.push(field);
  }
  const weakOnlyMatches: string[] = [];
  if (norm(a.displayName) && norm(a.displayName) === norm(b.displayName)) {
    weakOnlyMatches.push("displayName");
  }
  const canMerge = matchedStrongFields.length >= 2;
  return {
    canMerge,
    strongMatchCount: matchedStrongFields.length,
    matchedStrongFields,
    weakOnlyMatches,
    reason: canMerge
      ? `命中 ${matchedStrongFields.length} 项强证据（${matchedStrongFields.join("+")}），允许合并`
      : `强证据仅 ${matchedStrongFields.length} 项（需 >= 2 项，禁止仅凭昵称合并）`,
  };
}

export function runGardenerCycle(input: GardenerCycleInput): GardenerCycleOutput {
  const activeGoals = (input.ledger.goals ?? []).filter((g) => g.status === "active");
  const activeGoalIds = activeGoals.map((g) => g.id);
  const activeGoalSet = new Set(activeGoalIds);
  const rounds = input.recentRounds ?? [];
  let nonGoalRounds = 0;
  let totalCost = 0;
  let nonGoalCost = 0;
  for (const r of rounds) {
    totalCost += r.totalCostUsd ?? 0;
    const onGoal = Boolean(r.goalId && activeGoalSet.has(r.goalId));
    if (!onGoal) {
      nonGoalRounds++;
      nonGoalCost += r.totalCostUsd ?? 0;
    }
  }
  const nonGoalRoundShare = rounds.length > 0 ? Math.round((nonGoalRounds / rounds.length) * 1000) / 1000 : 0;
  const nonGoalCostShare = totalCost > 0 ? Math.round((nonGoalCost / totalCost) * 1000) / 1000 : 0;
  const derivedSurprise = input.currentSurprise ?? (nonGoalRoundShare > 0.7 ? 0.65 : 0.15);
  const surpriseMomentum = computeSurpriseMomentum(input.prevSurpriseMomentum, derivedSurprise);
  const urgentTriggered = surpriseMomentum >= URGENT_SURPRISE_THRESHOLD;
  const costTier = selectGardenerCostTier(Math.max(surpriseMomentum, nonGoalRoundShare));
  const tokenBudgetApplied =
    costTier === "tier0_deterministic" ? 0 : costTier === "tier1_template" ? Math.min(256, input.maxStewardTokenBudget) : input.maxStewardTokenBudget;

  const nextHypotheses: GardenerSandboxHypothesis[] = [];
  const promotedProposals: GardenerSandboxHypothesis[] = [];
  const discardedProposalIds: string[] = [];
  for (const h of input.hypotheses ?? []) {
    const updated = advanceSandboxHypothesis(h, input.sandboxEvents?.[h.id], input.nowIso);
    nextHypotheses.push(updated);
    if (h.state === "PROPOSED" && updated.state === "VALIDATED") promotedProposals.push(updated);
    if (h.state === "PROPOSED" && updated.state === "DISCARDED") discardedProposalIds.push(updated.id);
  }

  const demotedRuleIds = (input.ruleStats ?? [])
    .filter((r) => r.mode === "act" && r.emaEffectiveness < 0.35)
    .map((r) => r.ruleId);

  const tasteUpdates: LanguageTasteDelta[] = [];
  for (const [relId, entry] of Object.entries(input.recentMessagesByPeer ?? {})) {
    const delta = profilePeerLanguage(relId, entry.partition, entry.messages);
    if (delta) tasteUpdates.push(delta);
  }

  const nowMs = Date.parse(input.nowIso);
  const pruneEdgeIds: string[] = [];
  const prunedEdges: KGEdge[] = [];
  for (const edge of input.activeEdges ?? []) {
    if (edge.supersededAt) continue;
    const validMs = Date.parse(edge.validFrom);
    if (edge.weight < 0.2 || (Number.isFinite(validMs) && Number.isFinite(nowMs) && (nowMs - validMs) / MS_PER_DAY > 90)) {
      pruneEdgeIds.push(edge.id);
      prunedEdges.push(edge);
    }
  }
  const kgPruningDelta: KGDelta =
    prunedEdges.length > 0
      ? {
          edges: prunedEdges.map((e) => ({
            from: e.from,
            relation: e.relation,
            to: e.to,
            weight: 0,
            source: "memory_gardener_prune",
          })),
        }
      : {};

  const driftReport: GoalActionDriftReport = {
    windowDays: input.windowDays ?? 7,
    activeGoalIds,
    nonGoalRoundShare,
    nonGoalCostShare,
    surpriseMomentum,
    urgentTriggered,
  };
  const calibrationCardLines: [string, string, string] = [
    `偏航审计：非主目标事务占比 ${Math.round(nonGoalRoundShare * 100)}%（意外度动量 ${surpriseMomentum}）`,
    `沙盒与图谱：待晋升 ${promotedProposals.length} 项 · 退回 observe ${demotedRuleIds.length} 条 · 清理旧边 ${pruneEdgeIds.length} 条`,
    urgentTriggered ? "触发原因：异常动量越线，建议立即核对证伪墓碑" : "回复 1 采纳建议，或回复 2 保持现状",
  ];
  return { costTier, tokenBudgetApplied, driftReport, nextHypotheses, promotedProposals, discardedProposalIds, demotedRuleIds, tasteUpdates, pruneEdgeIds, kgPruningDelta, calibrationCardLines };
}


export interface GardenerSandboxState {
  version: 1;
  updatedAtIso: string;
  surpriseMomentum: number;
  lastRunAtIso: string;
  hypotheses: GardenerSandboxHypothesis[];
  lastReport?: GoalActionDriftReport;
  lastCalibrationLines?: [string, string, string];
}

export class GardenerStateStore {
  readonly filePath: string;
  private state: GardenerSandboxState;

  constructor(stewardDir: string) {
    this.filePath = path.join(path.resolve(stewardDir), "gardener-sandbox.json");
    this.state = this.load();
  }

  load(): GardenerSandboxState {
    const fallback: GardenerSandboxState = {
      version: 1,
      updatedAtIso: new Date(0).toISOString(),
      surpriseMomentum: 0,
      lastRunAtIso: new Date(0).toISOString(),
      hypotheses: [],
    };
    if (!fs.existsSync(this.filePath)) {
      this.state = fallback;
      return { ...fallback, hypotheses: [] };
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<GardenerSandboxState>;
      const loaded: GardenerSandboxState = {
        version: 1,
        updatedAtIso: typeof raw.updatedAtIso === "string" ? raw.updatedAtIso : fallback.updatedAtIso,
        surpriseMomentum:
          typeof raw.surpriseMomentum === "number" && Number.isFinite(raw.surpriseMomentum) ? raw.surpriseMomentum : 0,
        lastRunAtIso: typeof raw.lastRunAtIso === "string" ? raw.lastRunAtIso : fallback.lastRunAtIso,
        hypotheses: Array.isArray(raw.hypotheses) ? raw.hypotheses : [],
        ...(raw.lastReport ? { lastReport: raw.lastReport } : {}),
        ...(Array.isArray(raw.lastCalibrationLines) && raw.lastCalibrationLines.length === 3
          ? { lastCalibrationLines: raw.lastCalibrationLines as [string, string, string] }
          : {}),
      };
      this.state = loaded;
      return { ...loaded, hypotheses: loaded.hypotheses.map((h) => ({ ...h })) };
    } catch {
      this.state = fallback;
      return { ...fallback, hypotheses: [] };
    }
  }

  save(state: GardenerSandboxState): GardenerSandboxState {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const normalized: GardenerSandboxState = {
      version: 1,
      updatedAtIso: state.updatedAtIso,
      surpriseMomentum: state.surpriseMomentum,
      lastRunAtIso: state.lastRunAtIso,
      hypotheses: state.hypotheses.map((h) => ({ ...h })),
      ...(state.lastReport ? { lastReport: { ...state.lastReport } } : {}),
      ...(state.lastCalibrationLines
        ? { lastCalibrationLines: [...state.lastCalibrationLines] as [string, string, string] }
        : {}),
    };
    const tmp = `${this.filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.filePath);
    this.state = normalized;
    return this.getState();
  }

  getState(): GardenerSandboxState {
    return {
      ...this.state,
      hypotheses: this.state.hypotheses.map((h) => ({ ...h })),
      ...(this.state.lastReport ? { lastReport: { ...this.state.lastReport } } : {}),
      ...(this.state.lastCalibrationLines
        ? { lastCalibrationLines: [...this.state.lastCalibrationLines] as [string, string, string] }
        : {}),
    };
  }

  getHypotheses(): GardenerSandboxHypothesis[] {
    return this.state.hypotheses.map((h) => ({ ...h }));
  }

  setState(patch: Partial<GardenerSandboxState> | GardenerSandboxState): GardenerSandboxState {
    const next: GardenerSandboxState = {
      ...this.state,
      ...patch,
      version: 1,
      hypotheses: (patch.hypotheses ?? this.state.hypotheses).map((h) => ({ ...h })),
      updatedAtIso: patch.updatedAtIso ?? new Date().toISOString(),
    };
    return this.save(next);
  }
}


export function deriveGardenerHypotheses(params: {
  existing: GardenerSandboxHypothesis[];
  ledger: LedgerSnapshot;
  recentRounds: RoundTraceProjection[];
  unapprovedWorkflows?: Array<{ id: string; name: string; reinforcements: number }>;
  nowIso: string;
}): GardenerSandboxHypothesis[] {
  const byId = new Map<string, GardenerSandboxHypothesis>();
  for (const h of params.existing ?? []) {
    byId.set(h.id, { ...h });
  }

  const seedOrConfirm = (seed: {
    id: string;
    partition: ContextPartition;
    targetKind: GardenerSandboxHypothesis["targetKind"];
    statement: string;
  }): void => {
    const prev = byId.get(seed.id);
    if (!prev) {
      byId.set(seed.id, {
        id: seed.id,
        partition: seed.partition,
        targetKind: seed.targetKind,
        statement: seed.statement,
        state: "PROPOSED",
        confidence: SANDBOX_INITIAL_CONFIDENCE,
        confirmations: 1,
        contradictions: 0,
        createdAtIso: params.nowIso,
        lastEvidenceAtIso: params.nowIso,
      });
      return;
    }
    if (prev.state === "PROPOSED" && prev.lastEvidenceAtIso !== params.nowIso) {
      byId.set(seed.id, advanceSandboxHypothesis(prev, "confirm", params.nowIso));
    }
  };

  const activeGoalIds = new Set((params.ledger.goals ?? []).filter((g) => g.status === "active").map((g) => g.id));
  const rounds = params.recentRounds ?? [];
  if (rounds.length > 0) {
    const nonGoalCount = rounds.filter((r) => !(r.goalId && activeGoalIds.has(r.goalId))).length;
    const nonGoalRoundShare = nonGoalCount / rounds.length;
    if (nonGoalRoundShare >= 0.6) {
      seedOrConfirm({
        id: "hyp:goal-drift-alert",
        partition: "work_project",
        targetKind: "goal_drift_alert",
        statement: `近轮次偏离活跃北极星目标占比达 ${Math.round(nonGoalRoundShare * 100)}%，建议聚焦主目标或归档杂务`,
      });
    }
  }

  for (const wf of params.unapprovedWorkflows ?? []) {
    if (wf.reinforcements >= 2) {
      seedOrConfirm({
        id: `hyp:skill:${wf.id}`,
        partition: "work_project",
        targetKind: "skill_proposal",
        statement: `工作流「${wf.name}」已累计验证 ${wf.reinforcements} 次，建议批准结晶为固化技能`,
      });
    }
  }

  const failedRounds = rounds.filter((r) => r.status === "failed" || r.status === "circuit_broken");
  const failByRule = new Map<string, number>();
  const failByTitle = new Map<string, number>();
  for (const r of failedRounds) {
    if (r.ruleId) failByRule.set(r.ruleId, (failByRule.get(r.ruleId) ?? 0) + 1);
    const titleKey = (r.targetRef || r.title || "").trim();
    if (titleKey) failByTitle.set(titleKey, (failByTitle.get(titleKey) ?? 0) + 1);
  }
  let matchedSpecificFailure = false;
  for (const [ruleId, count] of failByRule.entries()) {
    if (count >= 2) {
      matchedSpecificFailure = true;
      seedOrConfirm({
        id: `hyp:fail-rule:${ruleId}`,
        partition: "work_project",
        targetKind: "rule_demotion",
        statement: `规则 ${ruleId} 近期连续失败 ${count} 次，建议降级观察或补充防护墓碑`,
      });
    }
  }
  for (const [label, count] of failByTitle.entries()) {
    if (count >= 2) {
      matchedSpecificFailure = true;
      const hash = crypto.createHash("sha256").update(label, "utf8").digest("hex").slice(0, 8);
      seedOrConfirm({
        id: `hyp:fail-pattern:${hash}`,
        partition: "work_project",
        targetKind: "tombstone",
        statement: `「${label.slice(0, 40)}」近期累计失败 ${count} 次，建议提炼为证伪墓碑避免重复踩坑`,
      });
    }
  }
  if (!matchedSpecificFailure && failedRounds.length >= 2) {
    seedOrConfirm({
      id: "hyp:repeated-failures",
      partition: "work_project",
      targetKind: "tombstone",
      statement: `近期出现 ${failedRounds.length} 次失败/熔断轮次，建议复盘并建立防错墓碑`,
    });
  }

  return Array.from(byId.values());
}


export function applyGardenerEffects(
  output: GardenerCycleOutput,
  targets: {
    knowledgeGraph: SugentKnowledgeGraph;
    ledger: StewardshipLedger;
    onDemoteRule?: (ruleId: string) => void;
    nowIso?: string;
  },
): { prunedEdges: number; updatedRelationships: number; writtenTombstones: number; demotedRules: number } {
  const nowIso = targets.nowIso ?? new Date().toISOString();
  let prunedEdges = 0;
  for (const edgeId of output.pruneEdgeIds ?? []) {
    if (targets.knowledgeGraph.removeEdge(edgeId, nowIso)) {
      prunedEdges += 1;
    }
  }

  let updatedRelationships = 0;
  const existingRels = targets.ledger.snapshotForCaller("owner_private").relationships;
  for (const taste of output.tasteUpdates ?? []) {
    if (!taste.suggestedPreferences.length) continue;
    const existing = existingRels.find((r) => r.id === taste.relationshipId || r.name === taste.relationshipId);
    const mergedPrefs = Array.from(new Set([...(existing?.preferences ?? []), ...taste.suggestedPreferences]));
    targets.ledger.upsertRelationship(
      {
        id: existing?.id ?? taste.relationshipId,
        partition: existing?.partition ?? taste.partition,
        name: existing?.name ?? taste.relationshipId,
        preferences: mergedPrefs,
      },
      nowIso,
    );
    updatedRelationships += 1;
  }

  let writtenTombstones = 0;
  const existingGuards = targets.ledger.snapshotForCaller("owner_private").guardrails;
  for (const proposal of output.promotedProposals ?? []) {
    if (proposal.state !== "VALIDATED" || proposal.targetKind !== "tombstone") continue;
    const guardId = `guard-tombstone-${proposal.id}`;
    const alreadyExists = existingGuards.some(
      (g) => g.id === guardId || (g.kind === "tombstone" && g.statement === proposal.statement),
    );
    if (alreadyExists) continue;
    targets.ledger.addGuardrail(
      {
        id: guardId,
        partition: proposal.partition,
        kind: "tombstone",
        statement: proposal.statement,
        evidenceSource: `memory_gardener:${proposal.id}`,
      },
      nowIso,
    );
    writtenTombstones += 1;
  }

  let demotedRules = 0;
  for (const ruleId of output.demotedRuleIds ?? []) {
    if (targets.onDemoteRule) {
      targets.onDemoteRule(ruleId);
      demotedRules += 1;
    }
  }

  return { prunedEdges, updatedRelationships, writtenTombstones, demotedRules };
}