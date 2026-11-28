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
import { looksSecret } from "../agent/memory.js";
import type { RoundTraceProjection } from "./causal-ledger.js";
import type { KGDelta, KGEdge, SugentKnowledgeGraph } from "./knowledge-graph.js";
import type { EpistemicDigestionLoop } from "./silicon-identity-core.js";
import {
  tokenizeForSearch,
  type AtlasEdgeInput,
  type AtlasNode,
  type AtlasNodeInput,
  type GraphPlaneId,
  type PrincipalId,
  type StereoscopicAtlas,
} from "./stereoscopic-atlas.js";
import type { ContextPartition, LedgerSnapshot, StewardshipLedger } from "./stewardship-ledger.js";

export const URGENT_SURPRISE_THRESHOLD = 0.7;
export const SANDBOX_INITIAL_CONFIDENCE = 0.3;
export const SANDBOX_VALIDATION_THRESHOLD = 3;
export const SANDBOX_MAX_CONTRADICTIONS = 2;
export const SANDBOX_EXPIRY_DAYS = 7;

export type GardenerCostTier = "tier0_deterministic" | "tier1_template" | "tier2_steward_llm";
export type HypothesisState = "PROPOSED" | "VALIDATED" | "DISCARDED";

export interface MemoryDisambiguationCard {
  cardId: string;
  plane: GraphPlaneId;
  topicKey: string;
  nodeA: { id: string; name: string; summary: string; updatedAt: string };
  nodeB: { id: string; name: string; summary: string; updatedAt: string };
  conflictReason: string;
  question: string;
  options: [string, string];
}

export interface SleepConsolidationOutput {
  triggered: boolean;
  triggerReason: "weekly_calibration" | "surprise_momentum" | "forced" | "idle_skipped";
  crystallizedNodes: AtlasNode[];
  synthesizedEdgesCount: number;
  disambiguationCards: MemoryDisambiguationCard[];
  expiredSandboxIds: string[];
  archivedNoiseEdgeIds: string[];
}

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
  pendingDisambiguationCards?: MemoryDisambiguationCard[];
  lastSleepConsolidation?: Omit<SleepConsolidationOutput, "crystallizedNodes"> & {
    crystallizedNodeIds: string[];
  };
}

function cloneDisambiguationCard(card: MemoryDisambiguationCard): MemoryDisambiguationCard {
  return {
    ...card,
    nodeA: { ...card.nodeA },
    nodeB: { ...card.nodeB },
    options: [card.options[0], card.options[1]],
  };
}

function cloneLastSleepSummary(
  s: NonNullable<GardenerSandboxState["lastSleepConsolidation"]>,
): NonNullable<GardenerSandboxState["lastSleepConsolidation"]> {
  return {
    triggered: s.triggered,
    triggerReason: s.triggerReason,
    crystallizedNodeIds: [...s.crystallizedNodeIds],
    synthesizedEdgesCount: s.synthesizedEdgesCount,
    disambiguationCards: s.disambiguationCards.map(cloneDisambiguationCard),
    expiredSandboxIds: [...s.expiredSandboxIds],
    archivedNoiseEdgeIds: [...s.archivedNoiseEdgeIds],
  };
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
        ...(Array.isArray(raw.pendingDisambiguationCards)
          ? { pendingDisambiguationCards: raw.pendingDisambiguationCards.map(cloneDisambiguationCard) }
          : {}),
        ...(raw.lastSleepConsolidation
          ? { lastSleepConsolidation: cloneLastSleepSummary(raw.lastSleepConsolidation) }
          : {}),
      };
      this.state = loaded;
      return this.getState();
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
      ...(state.pendingDisambiguationCards
        ? { pendingDisambiguationCards: state.pendingDisambiguationCards.map(cloneDisambiguationCard) }
        : {}),
      ...(state.lastSleepConsolidation
        ? { lastSleepConsolidation: cloneLastSleepSummary(state.lastSleepConsolidation) }
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
      ...(this.state.pendingDisambiguationCards
        ? { pendingDisambiguationCards: this.state.pendingDisambiguationCards.map(cloneDisambiguationCard) }
        : {}),
      ...(this.state.lastSleepConsolidation
        ? { lastSleepConsolidation: cloneLastSleepSummary(this.state.lastSleepConsolidation) }
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


const GENERIC_CLUSTER_TAGS = new Set([
  "post-turn",
  "domain_work",
  "owner_life",
  "self_core",
  "meta_evolution",
  "relational",
  "workflow",
  "preference",
  "archive",
  "review",
  "ops",
  "epistemic_sandbox",
  "epistemic_crystallized",
  "epistemic_tombstone",
  "sleep_consolidated",
  "episode_anchor",
]);

function isSpecificClusterTag(rawTag: string): boolean {
  const t = rawTag.trim().toLowerCase();
  if (!t || GENERIC_CLUSTER_TAGS.has(t)) return false;
  if (
    t.startsWith("topic:") ||
    t.startsWith("surface:") ||
    t.startsWith("ep:") ||
    t.startsWith("episode:")
  ) {
    return false;
  }
  return true;
}

function extractExplicitTopicTag(tags: readonly string[]): string | undefined {
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (trimmed.toLowerCase().startsWith("topic:")) {
      const val = trimmed.slice("topic:".length).trim().toLowerCase();
      if (val) return val;
    }
  }
  return undefined;
}

function extractNameEntityPrefix(name: string): string | undefined {
  const clean = name.trim();
  const cjk = clean.match(/[\u4e00-\u9fff]{4}/)?.[0];
  if (cjk) return cjk;
  const ascii = clean.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/)?.[0];
  return ascii;
}

export type MemoryConflictDetection = {
  kind: "numeric" | "polarity";
  reason: string;
};

function extractPaymentDays(text: string): number[] {
  const out: number[] = [];
  const push = (n: number) => {
    if (Number.isFinite(n) && n >= 0 && !out.includes(n)) out.push(n);
  };
  for (const m of text.matchAll(/(?:^|[^a-z0-9])net\s*(\d+(?:\.\d+)?)(?=$|[^a-z0-9])/gi)) {
    push(Number(m[1]));
  }
  for (const clause of text.split(/[。；;！!\n]+/)) {
    if (!/(?:账期|净账期|信用期|付款周期|结算期|回款|月结)/.test(clause)) continue;
    for (const m of clause.matchAll(/(\d+(?:\.\d+)?)\s*(?:个?工作日|天|日)/g)) {
      push(Number(m[1]));
    }
    for (const m of clause.matchAll(/(\d+(?:\.\d+)?)\s*个?月/g)) {
      push(Number(m[1]) * 30);
    }
  }
  return out;
}

function extractPriceValues(text: string): Array<{ raw: string; rmb: number }> {
  const out: Array<{ raw: string; rmb: number }> = [];
  const add = (numStr: string, unitStr: string) => {
    const val = Number(numStr);
    if (!Number.isFinite(val)) return;
    const u = unitStr.toLowerCase();
    const mult = u === "万" || u === "w" ? 10_000 : u === "千" || u === "k" ? 1_000 : 1;
    const rmb = val * mult;
    if (!out.some((x) => Math.abs(x.rmb - rmb) < 1e-6)) {
      out.push({ raw: `${numStr}${unitStr}`, rmb });
    }
  };
  const forwardRe = /(?:底价|最低价|单价|报价|总价|打包价|顾问费|年费|预算)[^，,。；;\n\d]{0,12}?(\d+(?:\.\d+)?)\s*(万|w|千|k|元)/gi;
  const reverseRe = /(\d+(?:\.\d+)?)\s*(万|w|千|k|元)[^，,。；;\n\d]{0,8}?(?:的)?(?:底价|最低价|单价|报价|总价|打包价|顾问费|年费|预算)/gi;
  for (const m of text.matchAll(forwardRe)) add(m[1]!, m[2]!);
  for (const m of text.matchAll(reverseRe)) add(m[1]!, m[2]!);
  return out;
}

function extractDownpaymentRatios(text: string): number[] {
  const out: number[] = [];
  const push = (n: number) => {
    if (Number.isFinite(n) && !out.includes(n)) out.push(n);
  };
  if (/(?:零首付|0\s*首付)/.test(text)) push(0);
  for (const m of text.matchAll(/(?:首付|预付款|启动款)[^，,。；;\n\d]{0,12}?(\d+(?:\.\d+)?)\s*%/g)) {
    push(Number(m[1]));
  }
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*%[^，,。；;\n\d]{0,6}?(?:首付|预付款|启动款)/g)) {
    push(Number(m[1]));
  }
  return out;
}

function extractGenericScopedNumbers(
  text: string,
  topicKey?: string,
): Array<{ attrTokens: string[]; num: number; unit: string; rawAttr: string }> {
  const out: Array<{ attrTokens: string[]; num: number; unit: string; rawAttr: string }> = [];
  const topicLower = topicKey?.trim().toLowerCase() ?? "";
  const re =
    /([\u4e00-\u9fffa-z0-9_-]{2,10}?)(?:上限|最多|不超过|不高于|至少|最低|不低于|不少于|设为|定为|控制在|限制在|保留|锁定)?\s*(\d+(?:\.\d+)?)\s*(天|日|小时|分钟|秒|ms|%|万|元|次|个|条|gb|mb)(?=$|[^a-z0-9])/gi;
  for (const m of text.matchAll(re)) {
    let rawAttr = m[1]!.trim();
    if (topicLower && rawAttr.toLowerCase().startsWith(topicLower)) {
      rawAttr = rawAttr.slice(topicLower.length).trim();
    }
    rawAttr = rawAttr.replace(/(?:上限|最多|不超过|不高于|至少|最低|不低于|不少于|比例|额度|标准|要求|调整为|改为)/g, "").trim();
    if (rawAttr.length < 2) continue;
    const attrTokens = tokenizeForSearch(rawAttr).filter((t) => t.length >= 2);
    if (attrTokens.length === 0) continue;
    const num = Number(m[2]);
    if (!Number.isFinite(num)) continue;
    const rawUnit = m[3]!.toLowerCase();
    const unit = rawUnit === "日" ? "天" : rawUnit;
    out.push({ attrTokens, num, unit, rawAttr });
  }
  return out;
}

const PROHIBITIVE_DIRECTIVE_RE = /(?:禁止|严禁|不得|切勿|不要|绝不|不能|不可|拒绝|不接受|关闭|禁用)/;
const PERMISSIVE_DIRECTIVE_RE = /(?:允许|可以|可直接|直接|默认开启|开启|启用|无需|免审|跳过|接受|放行)/;
const STRIP_POLARITY_CUE_RE =
  /(?:禁止|严禁|不得|切勿|不要|绝不|不能|不可|拒绝|不接受|关闭|禁用|允许|可以|默认开启|开启|启用|无需|免审|接受|放行)/g;
const MANNER_STOP_TOKENS = new Set([
  "直接",
  "跳过",
  "默认",
  "目前",
  "现在",
  "一律",
  "统一",
  "先发",
  "规定",
  "策略",
  "规则",
  "要求",
]);

function extractClausePolarityInfos(
  text: string,
): Array<{ polarity: "prohibitive" | "permissive"; tokens: string[]; postCueTokens: Set<string> }> {
  const out: Array<{ polarity: "prohibitive" | "permissive"; tokens: string[]; postCueTokens: Set<string> }> = [];
  const clauses = text.split(/[。；;！!\n]+|(?:[，,]\s*(?:但|但是|不过|然而|而))/);
  for (const rawClause of clauses) {
    const c = rawClause.trim();
    if (!c) continue;
    const prohibMatch = PROHIBITIVE_DIRECTIVE_RE.exec(c);
    const isProhib = Boolean(prohibMatch);
    const permMatch = !isProhib ? PERMISSIVE_DIRECTIVE_RE.exec(c) : null;
    const isPerm = Boolean(permMatch);
    if (!isProhib && !isPerm) continue;
    const cueMatch = prohibMatch ?? permMatch!;
    const afterCue = c.slice(cueMatch.index + cueMatch[0].length);
    const postCueTokens = new Set(
      tokenizeForSearch(afterCue.replace(STRIP_POLARITY_CUE_RE, " ")).filter(
        (tok) => tok.length >= 2 && !MANNER_STOP_TOKENS.has(tok),
      ),
    );
    const stripped = c.replace(STRIP_POLARITY_CUE_RE, " ");
    const tokens = tokenizeForSearch(stripped).filter(
      (tok) => tok.length >= 2 && !MANNER_STOP_TOKENS.has(tok),
    );
    if (tokens.length > 0) {
      out.push({ polarity: isProhib ? "prohibitive" : "permissive", tokens, postCueTokens });
    }
  }
  return out;
}

export function detectPairwiseMemoryConflict(
  a: Pick<AtlasNode, "name" | "summary"> & Partial<Pick<AtlasNode, "id" | "tags">>,
  b: Pick<AtlasNode, "name" | "summary"> & Partial<Pick<AtlasNode, "id" | "tags">>,
  topicKey?: string,
): MemoryConflictDetection | null {
  const textA = `${a.name ?? ""}。${a.summary ?? ""}`.trim();
  const textB = `${b.name ?? ""}。${b.summary ?? ""}`.trim();
  if (!textA || !textB || textA === textB) return null;

  const daysA = extractPaymentDays(textA);
  const daysB = extractPaymentDays(textB);
  if (daysA.length > 0 && daysB.length > 0 && !daysA.some((d) => daysB.includes(d))) {
    return {
      kind: "numeric",
      reason: `账期/结算天数互斥（${daysA[0]}天 vs ${daysB[0]}天）`,
    };
  }

  const pricesA = extractPriceValues(textA);
  const pricesB = extractPriceValues(textB);
  if (
    pricesA.length > 0 &&
    pricesB.length > 0 &&
    !pricesA.some((pa) => pricesB.some((pb) => Math.abs(pa.rmb - pb.rmb) < 1e-6))
  ) {
    return {
      kind: "numeric",
      reason: `价格/报价数值互斥（${pricesA[0]!.raw} vs ${pricesB[0]!.raw}）`,
    };
  }

  const dpA = extractDownpaymentRatios(textA);
  const dpB = extractDownpaymentRatios(textB);
  if (dpA.length > 0 && dpB.length > 0 && !dpA.some((v) => dpB.includes(v))) {
    return {
      kind: "numeric",
      reason: `首付比例互斥（${dpA[0]}% vs ${dpB[0]}%）`,
    };
  }

  const scopedA = extractGenericScopedNumbers(textA, topicKey);
  const scopedB = extractGenericScopedNumbers(textB, topicKey);
  for (const sa of scopedA) {
    const setA = new Set(sa.attrTokens);
    for (const sb of scopedB) {
      if (sa.unit !== sb.unit || Math.abs(sa.num - sb.num) < 1e-9) continue;
      if (sb.attrTokens.some((t) => setA.has(t))) {
        return {
          kind: "numeric",
          reason: `同属性「${sa.rawAttr}」数值互斥（${sa.num}${sa.unit} vs ${sb.num}${sb.unit}）`,
        };
      }
    }
  }

  const topicTokenSet = topicKey ? new Set(tokenizeForSearch(topicKey)) : new Set<string>();
  const polA = extractClausePolarityInfos(textA);
  const polB = extractClausePolarityInfos(textB);
  for (const ca of polA) {
    for (const cb of polB) {
      if (ca.polarity === cb.polarity) continue;
      const postA = Array.from(ca.postCueTokens).filter((t) => !topicTokenSet.has(t));
      const postB = Array.from(cb.postCueTokens).filter((t) => !topicTokenSet.has(t));
      let sharedList: string[] = [];
      if (postA.length > 0 && postB.length > 0) {
        const setPostA = new Set(postA);
        sharedList = postB.filter((t) => setPostA.has(t));
      } else {
        const remA = ca.tokens.filter((t) => !topicTokenSet.has(t));
        const remB = cb.tokens.filter((t) => !topicTokenSet.has(t));
        const poolA = remA.length > 0 && remB.length > 0 ? remA : ca.tokens;
        const poolB = remA.length > 0 && remB.length > 0 ? remB : cb.tokens;
        const setPoolA = new Set(poolA);
        sharedList = poolB.filter((t) => setPoolA.has(t));
      }
      if (sharedList.length > 0) {
        const label = Array.from(new Set(sharedList)).slice(0, 3).join("/");
        return {
          kind: "polarity",
          reason: `指令极性互斥（围绕「${label}」一方禁止/关闭，另一方允许/放行）`,
        };
      }
    }
  }

  return null;
}

function removeAtlasNoiseOrOrphanEdge(
  atlas: StereoscopicAtlas,
  edgeId: string,
  nowIso: string,
  nowMs: number,
): boolean {
  const edge = atlas.getEdge(edgeId);
  if (!edge || edge.supersededAt) return false;

  const preTo = atlas.getNode(edge.to);
  const shouldPreserveTarget =
    Boolean(preTo && !preTo.supersededAt && !preTo.archivedAt) &&
    !(
      preTo!.stratum === "raw_episodic" &&
      Number.isFinite(Date.parse(preTo!.updatedAt)) &&
      Number.isFinite(nowMs) &&
      (nowMs - Date.parse(preTo!.updatedAt)) / MS_PER_DAY > 90
    );
  const snapshotTo =
    shouldPreserveTarget && preTo
      ? {
          ...preTo,
          tags: [...preTo.tags],
          principalAcl: [...preTo.principalAcl],
          ...(preTo.steps ? { steps: [...preTo.steps] } : {}),
        }
      : undefined;

  const removed = atlas.removeEdge(edgeId, nowIso);
  if (!removed) return false;

  if (snapshotTo) {
    const postTo = atlas.getNode(snapshotTo.id);
    if (postTo?.supersededAt && !snapshotTo.supersededAt) {
      atlas.applyDelta(
        {
          nodes: [
            {
              id: snapshotTo.id,
              plane: snapshotTo.plane,
              stratum: snapshotTo.stratum,
              kind: snapshotTo.kind,
              name: snapshotTo.name,
              summary: snapshotTo.summary,
              tags: snapshotTo.tags,
              principalAcl: snapshotTo.principalAcl,
              reinforcements: 0,
              confidence: snapshotTo.confidence,
              sourceTrust: snapshotTo.sourceTrust,
              ...(snapshotTo.steps?.length ? { steps: snapshotTo.steps } : {}),
              ...(snapshotTo.skillGateStatus ? { skillGateStatus: snapshotTo.skillGateStatus } : {}),
            },
          ],
        },
        snapshotTo.updatedAt,
      );
    }
  }
  return true;
}

export function runAtlasSleepConsolidation(params: {
  atlas: StereoscopicAtlas;
  mindLoop?: EpistemicDigestionLoop;
  nowIso: string;
  surpriseMomentum?: number;
  weeklyCalibrationDue?: boolean;
  force?: boolean;
  sandboxExpiryDays?: number;
}): SleepConsolidationOutput {
  const momentum = params.surpriseMomentum ?? 0;
  const triggerReason: SleepConsolidationOutput["triggerReason"] =
    params.force === true
      ? "forced"
      : params.weeklyCalibrationDue === true
        ? "weekly_calibration"
        : momentum >= URGENT_SURPRISE_THRESHOLD
          ? "surprise_momentum"
          : "idle_skipped";

  if (triggerReason === "idle_skipped") {
    return {
      triggered: false,
      triggerReason: "idle_skipped",
      crystallizedNodes: [],
      synthesizedEdgesCount: 0,
      disambiguationCards: [],
      expiredSandboxIds: [],
      archivedNoiseEdgeIds: [],
    };
  }

  const nowIso = params.nowIso;
  const nowMs = Date.parse(nowIso);
  const expiryDays = params.sandboxExpiryDays ?? SANDBOX_EXPIRY_DAYS;

  // Step C.1 (early): Expire >7d unconfirmed sandbox hypotheses so stale hypotheses don't pollute Step A/B
  const expiredSet = new Set<string>(
    params.mindLoop?.pruneExpiredSandboxEntries(expiryDays, nowIso) ?? [],
  );
  for (const node of params.atlas.allNodes({ includeSuperseded: false })) {
    const isSandboxNode =
      (node.kind === "hypothesis" || node.tags.includes("epistemic_sandbox")) &&
      node.stratum !== "crystallized_wisdom";
    if (!isSandboxNode || node.reinforcements >= SANDBOX_VALIDATION_THRESHOLD) continue;
    const updatedMs = Date.parse(node.updatedAt);
    if (Number.isFinite(nowMs) && Number.isFinite(updatedMs) && (nowMs - updatedMs) / MS_PER_DAY >= expiryDays) {
      if (params.atlas.archiveNode(node.id, nowIso)) {
        expiredSet.add(node.id);
      }
    }
  }

  // Step A: Same-plane topic clustering & pairwise contradiction scan
  const eligibleForClustering = params.atlas.allNodes({ includeSuperseded: false }).filter((n) => {
    if (n.kind === "episode_anchor" || n.tags.includes("episode_anchor") || n.id.startsWith("ep:")) return false;
    if (n.tags.includes("sleep_consolidated") || n.id.startsWith("syn:")) return false;
    return true;
  });

  const nodesByPlane = new Map<GraphPlaneId, AtlasNode[]>();
  for (const node of eligibleForClustering) {
    const list = nodesByPlane.get(node.plane) ?? [];
    list.push(node);
    nodesByPlane.set(node.plane, list);
  }

  const clusters = new Map<string, { plane: GraphPlaneId; topicKey: string; members: AtlasNode[] }>();
  for (const [plane, planeNodes] of nodesByPlane.entries()) {
    const tagFreq = new Map<string, number>();
    for (const n of planeNodes) {
      const seenOnNode = new Set<string>();
      const explicitTopic = extractExplicitTopicTag(n.tags);
      if (explicitTopic) seenOnNode.add(explicitTopic);
      for (const tag of n.tags) {
        if (isSpecificClusterTag(tag)) {
          seenOnNode.add(tag.trim().toLowerCase());
        }
      }
      for (const t of seenOnNode) {
        tagFreq.set(t, (tagFreq.get(t) ?? 0) + 1);
      }
    }

    for (const n of planeNodes) {
      let topicKey = extractExplicitTopicTag(n.tags);
      if (!topicKey) {
        let bestTag: string | undefined;
        let bestFreq = 1;
        for (const tag of n.tags) {
          if (!isSpecificClusterTag(tag)) continue;
          const norm = tag.trim().toLowerCase();
          const freq = tagFreq.get(norm) ?? 0;
          if (freq >= 2 && freq > bestFreq) {
            bestFreq = freq;
            bestTag = norm;
          }
        }
        topicKey =
          bestTag ??
          extractNameEntityPrefix(n.name) ??
          n.tags.find(isSpecificClusterTag)?.trim().toLowerCase() ??
          n.id;
      }
      const clusterKey = `${plane}::${topicKey}`;
      const bucket = clusters.get(clusterKey) ?? { plane, topicKey, members: [] };
      bucket.members.push(n);
      clusters.set(clusterKey, bucket);
    }
  }

  const disambiguationCards: MemoryDisambiguationCard[] = [];
  const conflictedClusterKeys = new Set<string>();

  for (const [clusterKey, cluster] of clusters.entries()) {
    if (cluster.members.length < 2) continue;
    const sorted = [...cluster.members].sort((x, y) =>
      x.updatedAt === y.updatedAt ? x.id.localeCompare(y.id) : x.updatedAt.localeCompare(y.updatedAt),
    );
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i]!;
        const b = sorted[j]!;
        const conflict = detectPairwiseMemoryConflict(a, b, cluster.topicKey);
        if (!conflict) continue;
        conflictedClusterKeys.add(clusterKey);
        const pairHash = crypto
          .createHash("sha256")
          .update(`${cluster.plane}:${cluster.topicKey}:${[a.id, b.id].sort().join("|")}`)
          .digest("hex")
          .slice(0, 10);
        disambiguationCards.push({
          cardId: `disambig:${pairHash}`,
          plane: cluster.plane,
          topicKey: cluster.topicKey,
          nodeA: { id: a.id, name: a.name, summary: a.summary, updatedAt: a.updatedAt },
          nodeB: { id: b.id, name: b.name, summary: b.summary, updatedAt: b.updatedAt },
          conflictReason: conflict.reason,
          question: `检测到同平面（${cluster.plane} · ${cluster.topicKey}）存在互斥记忆：「${a.summary.slice(0, 48)}」 vs 「${b.summary.slice(0, 48)}」（${conflict.reason}），请确认保留哪一条？`,
          options: [
            `保留「${a.summary.slice(0, 36)}」并归档旧条`,
            `保留「${b.summary.slice(0, 36)}」并归档旧条`,
          ],
        });
      }
    }
  }

  // Step B: Coherent cluster synthesis (>= 3 verified_fact / raw_episodic & 0 conflicts -> crystallized_wisdom)
  const crystallizedNodes: AtlasNode[] = [];
  let synthesizedEdgesCount = 0;

  for (const [clusterKey, cluster] of clusters.entries()) {
    if (conflictedClusterKeys.has(clusterKey)) continue;
    const eligibleMembers = cluster.members
      .filter(
        (m) =>
          (m.stratum === "verified_fact" || m.stratum === "raw_episodic") &&
          !looksSecret(`${m.name}\n${m.summary}`),
      )
      .sort((x, y) =>
        x.updatedAt === y.updatedAt ? x.id.localeCompare(y.id) : x.updatedAt.localeCompare(y.updatedAt),
      );
    if (eligibleMembers.length < 3) continue;

    const topicSlug =
      cluster.topicKey
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff_-]+/g, "-")
        .replace(/^-+|-+$/g, "") ||
      crypto.createHash("sha256").update(cluster.topicKey).digest("hex").slice(0, 8);
    const synId = `syn:${cluster.plane}:${topicSlug}`;

    const existingSyn = params.atlas.getNode(synId);
    const existingSynthTargets = new Set(
      params.atlas
        .activeEdges(cluster.plane)
        .filter((e) => e.from === synId && e.relation === "synthesized_from")
        .map((e) => e.to),
    );
    if (
      existingSyn &&
      !existingSyn.supersededAt &&
      !existingSyn.archivedAt &&
      eligibleMembers.every((m) => existingSynthTargets.has(m.id))
    ) {
      continue;
    }

    const firstAcl = eligibleMembers[0]!.principalAcl;
    const intersectedAcl = firstAcl.filter((p) =>
      eligibleMembers.every((m) => m.principalAcl.includes(p)),
    );
    const principalAcl: PrincipalId[] =
      intersectedAcl.length > 0 ? Array.from(new Set(intersectedAcl)) : ["owner:M"];

    const distinctSummaries = Array.from(
      new Set(eligibleMembers.map((m) => m.summary.trim()).filter(Boolean)),
    );
    const summary = `【${cluster.topicKey} 归纳结晶（综合 ${eligibleMembers.length} 条互恰记忆）】${distinctSummaries.slice(0, 6).join("；")}`;
    if (looksSecret(`${cluster.topicKey}\n${summary}`)) continue;

    const reinfDelta = existingSyn
      ? Math.max(0, eligibleMembers.length - existingSyn.reinforcements)
      : eligibleMembers.length;
    const nodeInput: AtlasNodeInput = {
      id: synId,
      plane: cluster.plane,
      stratum: "crystallized_wisdom",
      kind: "canon",
      name: `${cluster.topicKey} 归纳结晶`,
      summary,
      tags: ["sleep_consolidated", `topic:${cluster.topicKey}`],
      principalAcl,
      confidence: 0.92,
      sourceTrust: "deterministic_gate",
      reinforcements: reinfDelta,
    };

    const missingMembers = eligibleMembers.filter((m) => !existingSynthTargets.has(m.id));
    const edgeInputs: AtlasEdgeInput[] = missingMembers.map((m) => ({
      plane: cluster.plane,
      from: synId,
      relation: "synthesized_from",
      to: m.id,
      weight: 1,
      source: "gardener_sleep_consolidation",
      principalAcl: ["owner:M"],
    }));

    params.atlas.applyDelta({ nodes: [nodeInput], edges: edgeInputs }, nowIso);
    synthesizedEdgesCount += edgeInputs.length;
    const written = params.atlas.getNode(synId);
    if (written) {
      crystallizedNodes.push(written);
    }
  }

  // Step C.2: Archive orphan / low-weight / >90d raw_episodic noise edges
  const archivedNoiseEdgeIds: string[] = [];
  for (const edge of params.atlas.activeEdges()) {
    const fromNode = params.atlas.getNode(edge.from);
    const toNode = params.atlas.getNode(edge.to);
    const isOrphanEndpoint = Boolean(
      !fromNode ||
        fromNode.archivedAt ||
        fromNode.supersededAt ||
        !toNode ||
        toNode.archivedAt ||
        toNode.supersededAt,
    );
    const isLowWeight = edge.weight < 0.2;
    const validMs = Date.parse(edge.validFrom);
    const isStaleRawEpisodic = Boolean(
      toNode?.stratum === "raw_episodic" &&
        Number.isFinite(nowMs) &&
        Number.isFinite(validMs) &&
        (nowMs - validMs) / MS_PER_DAY > 90,
    );

    if (isOrphanEndpoint || isLowWeight || isStaleRawEpisodic) {
      if (removeAtlasNoiseOrOrphanEdge(params.atlas, edge.id, nowIso, nowMs)) {
        archivedNoiseEdgeIds.push(edge.id);
      }
    }
  }

  return {
    triggered: true,
    triggerReason,
    crystallizedNodes,
    synthesizedEdgesCount,
    disambiguationCards,
    expiredSandboxIds: Array.from(expiredSet),
    archivedNoiseEdgeIds,
  };
}


export function applyGardenerEffects(
  output: GardenerCycleOutput,
  targets: {
    knowledgeGraph: SugentKnowledgeGraph;
    ledger: StewardshipLedger;
    atlas?: StereoscopicAtlas;
    mindLoop?: EpistemicDigestionLoop;
    weeklyCalibrationDue?: boolean;
    onDemoteRule?: (ruleId: string) => void;
    nowIso?: string;
  },
): {
  prunedEdges: number;
  updatedRelationships: number;
  writtenTombstones: number;
  demotedRules: number;
  sleepConsolidation?: SleepConsolidationOutput;
} {
  const nowIso = targets.nowIso ?? new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  let prunedEdges = 0;
  for (const edgeId of output.pruneEdgeIds ?? []) {
    const removedKg = targets.knowledgeGraph.removeEdge(edgeId, nowIso);
    const removedAtlas = targets.atlas
      ? removeAtlasNoiseOrOrphanEdge(targets.atlas, edgeId, nowIso, nowMs)
      : false;
    if (removedKg || removedAtlas) {
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

  const sleepConsolidation = targets.atlas
    ? runAtlasSleepConsolidation({
        atlas: targets.atlas,
        mindLoop: targets.mindLoop,
        nowIso,
        surpriseMomentum: output.driftReport.surpriseMomentum,
        weeklyCalibrationDue: targets.weeklyCalibrationDue,
      })
    : undefined;

  return {
    prunedEdges,
    updatedRelationships,
    writtenTombstones,
    demotedRules,
    ...(sleepConsolidation ? { sleepConsolidation } : {}),
  };
}