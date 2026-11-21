/**
 * 离线记忆园丁与认知对齐巡检引擎（src/sugent/memory-gardener.ts）
 *
 * 严格遵循「闲时不空转，仅在周度校准或 Titans 意外度动量 >= 0.7 时触发」原则：
 * 1. Goal-vs-Action 偏航审计：统计非主目标工作占比并生成周期算账提示；
 * 2. DreamSandbox 假说沙盒：PROPOSED (0.3) -> 3 次现实印证转正，2 次驳回或超 7 天过期淘汰；
 * 3. Titans 意外度动量与 AdaptiveCoherentizer 三档成本控制（<0.2 / 0.2-0.5 / >=0.5）；
 * 4. LanguageProfiler 零 LLM 软品味提取与 MergeGuard（>= 2 强证据）跨端合号门禁。
 */
import type { RoundTraceProjection } from "./causal-ledger.js";
import type { KGDelta, KGEdge } from "./knowledge-graph.js";
import type { ContextPartition, LedgerSnapshot } from "./stewardship-ledger.js";

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
  for (const edge of input.activeEdges ?? []) {
    if (edge.supersededAt) continue;
    const validMs = Date.parse(edge.validFrom);
    if (edge.weight < 0.2 || (Number.isFinite(validMs) && Number.isFinite(nowMs) && (nowMs - validMs) / MS_PER_DAY > 90)) {
      pruneEdgeIds.push(edge.id);
    }
  }

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
  return { costTier, tokenBudgetApplied, driftReport, nextHypotheses, promotedProposals, discardedProposalIds, demotedRuleIds, tasteUpdates, pruneEdgeIds, kgPruningDelta: {}, calibrationCardLines };
}