import crypto from "node:crypto";
import type { CausalLedger } from "./causal-ledger.js";
import type { LocalBudgetLedger } from "./local-budget.js";
import type {
  ModelFamily,
  ModelTier,
  SugentModelCatalog,
} from "./model-catalog.js";
import type {
  ModelPoolSnapshot,
  ModelPoolSyncer,
  SyncedModelEntry,
} from "./model-pool-sync.js";
import {
  deriveMagpieApiBases,
  type ProviderRegistry,
} from "./provider-registry.js";
import type {
  RecordedRouteDecision,
  RoutingExperienceStore,
  RoutingOperatingMode,
  RoutingOutcomeEvent,
  RoutingPolicyState,
  RoutingStrategyPreset,
  TaskArchetype,
} from "./routing-experience-store.js";
import type { ModelRole } from "./types.js";

export interface RoutingRequestContext {
  role: ModelRole;
  text: string;
  historyChars?: number;
  systemPromptChars?: number;
  hasImages?: boolean;
  hasTools?: boolean;
  excludeTargetIds?: string[];
  forceMinTier?: ModelTier;
  botId?: string;
}

export interface TaskClassification {
  archetype: TaskArchetype;
  confidence: number;
  estimatedInputTokens: number;
  signals: string[];
}

export interface ResolvedRouteEndpoint {
  targetId: string;
  providerId: string;
  rawModelId: string;
  baseUrl: string;
  apiKey: string;
  tier: ModelTier;
  family: ModelFamily;
  thoughtSignatureRequired: boolean;
}

export interface CandidateScoreBreakdown {
  targetId: string;
  totalScore: number;
  qualityScore: number;
  healthScore: number;
  speedScore: number;
  effectiveCost: number;
  exploreBonus: number;
  tierAffinity: number;
  policyBoost: number;
}
export interface RouteDecisionPlan {
  decisionId: string;
  archetype: TaskArchetype;
  classification: TaskClassification;
  mode: RoutingOperatingMode;
  strategy: RoutingStrategyPreset;
  primary: ResolvedRouteEndpoint;
  infraFallbacks: ResolvedRouteEndpoint[];
  escalationTarget?: ResolvedRouteEndpoint;
  shadowRecommendedTargetId?: string;
  reasonSummary: string;
  skippedCoolingModels: string[];
  scoredCandidates: CandidateScoreBreakdown[];
}

export interface AdaptiveRoutingDashboardSnapshot {
  mode: RoutingOperatingMode;
  strategy: RoutingStrategyPreset;
  pinnedModel?: string;
  pool: ModelPoolSnapshot;
  policy: RoutingPolicyState;
  recentDecisions: RecordedRouteDecision[];
  leaderboard: ReturnType<RoutingExperienceStore["getLeaderboardByArchetype"]>;
}

const TIER_ORDER: Record<ModelTier, number> = {
  fast: 0,
  balanced: 1,
  frontier: 2,
  reasoning: 3,
};

const STRATEGY_WEIGHTS: Record<
  RoutingStrategyPreset,
  { wQ: number; wH: number; wS: number; wC: number }
> = {
  quota_saver: { wQ: 0.34, wH: 0.2, wS: 0.16, wC: 0.3 },
  balanced: { wQ: 0.48, wH: 0.2, wS: 0.14, wC: 0.18 },
  quality_first: { wQ: 0.64, wH: 0.18, wS: 0.1, wC: 0.08 },
};

const ARCHETYPE_AFFINITY: Record<TaskArchetype, Record<ModelTier, number>> = {
  quick_chat_capture: { fast: 0.12, balanced: 0.04, frontier: -0.04, reasoning: -0.08 },
  tool_orchestration: { fast: -0.02, balanced: 0.06, frontier: 0.06, reasoning: 0.01 },
  long_doc_synthesis: { fast: -0.05, balanced: 0.03, frontier: 0.07, reasoning: 0.04 },
  deep_reasoning_plan: { fast: -0.1, balanced: 0.0, frontier: 0.07, reasoning: 0.09 },
  coding_and_review: { fast: -0.08, balanced: 0.01, frontier: 0.08, reasoning: 0.08 },
  vision_gui: { fast: -0.06, balanced: 0.02, frontier: 0.08, reasoning: 0.04 },
};

/**
 * Zero-LLM-latency (<5ms) heuristic classifier mapping a request into one of 6 task archetypes.
 */
export function classifyTaskArchetype(ctx: RoutingRequestContext): TaskClassification {
  const txt = ctx.text.trim();
  const estTokens = Math.ceil(
    ((ctx.systemPromptChars ?? 4_000) + (ctx.historyChars ?? 0) + txt.length) / 2.2,
  );
  if (
    ctx.hasImages ||
    ctx.role === "computer_use" ||
    /(截图|看图|屏幕|界面|\bui\b|screenshot|点击)/i.test(txt)
  ) {
    return { archetype: "vision_gui", confidence: 0.9, estimatedInputTokens: estTokens, signals: ["vision_or_gui"] };
  }
  if (
    estTokens >= 24_000 ||
    /(完整.*报告|原文|全文|daily_review|\.md|read_authorized_file|长文|汇总全天)/i.test(txt)
  ) {
    return { archetype: "long_doc_synthesis", confidence: 0.88, estimatedInputTokens: estTokens, signals: ["long_context_or_full_doc"] };
  }
  if (
    ctx.role === "executor" ||
    /(代码|源码|重构|报错|单测|编译|\b(?:typecheck|worktree|vibe|commit|git|typescript|bug|debug|fix|refactor)\b)/i.test(
      txt,
    )
  ) {
    return { archetype: "coding_and_review", confidence: 0.88, estimatedInputTokens: estTokens, signals: ["coding_or_executor"] };
  }
  if (
    /(为什么|怎么设计|架构|方案|规划|策划|利弊|权衡|评估|决策|\b(?:strategy|architecture|plan)\b)/i.test(
      txt,
    ) ||
    txt.length >= 220
  ) {
    return { archetype: "deep_reasoning_plan", confidence: 0.82, estimatedInputTokens: estTokens, signals: ["complex_reasoning"] };
  }
  if (
    /(来信|回复|微信|飞书|客户|目标|简报|\b(?:project|session|antigravity)\b|绑定|派发|批准|重启|日程|政务|跑腿)/i.test(
      txt,
    )
  ) {
    return { archetype: "tool_orchestration", confidence: 0.8, estimatedInputTokens: estTokens, signals: ["tool_action"] };
  }
  return { archetype: "quick_chat_capture", confidence: 0.78, estimatedInputTokens: estTokens, signals: ["short_capture_or_chat"] };
}

/**
 * Contextual Bandit model router combining Bayesian decayed posteriors,
 * hard capability pruning, cross-family fallbacks, and budget/quota pressure.
 */
export class AdaptiveModelRouter {
  private readonly nowMs: () => number;

  constructor(
    private readonly opts: {
      pool: ModelPoolSyncer;
      experience: RoutingExperienceStore;
      providers: ProviderRegistry;
      catalog: SugentModelCatalog;
      localBudgets?: LocalBudgetLedger;
      causalLedger?: CausalLedger;
      getFallbackEndpoint?: () =>
        | { baseUrl: string; apiKey: string; model: string }
        | undefined;
      nowMs?: () => number;
    },
  ) {
    this.nowMs = opts.nowMs ?? (() => Date.now());
  }

  private toEndpoint(entry: SyncedModelEntry): ResolvedRouteEndpoint | undefined {
    const prov = this.opts.providers.getProvider(entry.providerId);
    if (!prov || !prov.enabled || !prov.baseUrl) return undefined;
    const chatBase = deriveMagpieApiBases(prov).chat || prov.baseUrl;
    return {
      targetId: entry.targetId,
      providerId: prov.id,
      rawModelId: entry.rawModelId,
      baseUrl: chatBase,
      apiKey: prov.apiKey,
      tier: entry.profile.tier,
      family: entry.profile.family,
      thoughtSignatureRequired: entry.profile.thoughtSignatureRequired,
    };
  }

  private scoreEntry(
    entry: SyncedModelEntry,
    archetype: TaskArchetype,
    policy: RoutingPolicyState,
    totalSamples: number,
    w: { wQ: number; wH: number; wS: number; wC: number },
    costMult: number,
    now: number,
  ): CandidateScoreBreakdown {
    const post = this.opts.experience.getPosterior(
      archetype,
      entry.targetId,
      entry.profile.priorQuality,
      now,
    );
    const baseSpeed =
      entry.profile.tier === "fast"
        ? 0.92
        : entry.profile.tier === "balanced"
          ? 0.78
          : entry.profile.tier === "frontier"
            ? 0.58
            : 0.4;
    const speedScore =
      post.ewmaTtftMs !== null
        ? Math.max(0.1, Math.min(1, 1 - (post.ewmaTtftMs - 200) / 5000))
        : baseSpeed;
    const usdNorm = entry.profile.rates
      ? Math.min(1, (entry.profile.rates.input + entry.profile.rates.output * 0.25) / 18)
      : 0;
    const effectiveCost = Math.min(1, Math.max(usdNorm, entry.profile.quotaScarcity * 0.85));
    const isLowRiskExplore =
      archetype === "quick_chat_capture" ||
      archetype === "tool_orchestration" ||
      archetype === "long_doc_synthesis";
    const exploreBonus =
      policy.mode === "auto" && isLowRiskExplore && post.effectiveSamples < 5
        ? 0.09 * Math.sqrt(Math.log(Math.max(2, totalSamples + 2)) / (post.effectiveSamples + 1))
        : 0;
    const tierAffinity = ARCHETYPE_AFFINITY[archetype][entry.profile.tier];
    const policyBoost =
      (policy.archetypeBoosts[archetype]?.[entry.targetId] ?? 0) -
      (entry.circuit.state === "half_open" ? 0.08 : 0);
    const totalScore =
      w.wQ * post.posteriorQuality +
      w.wH * post.reliability +
      w.wS * speedScore -
      w.wC * costMult * effectiveCost +
      exploreBonus +
      tierAffinity +
      policyBoost;
    return {
      targetId: entry.targetId,
      totalScore,
      qualityScore: post.posteriorQuality,
      healthScore: post.reliability,
      speedScore,
      effectiveCost,
      exploreBonus,
      tierAffinity,
      policyBoost,
    };
  }

  private pruneCandidates(
    ctx: RoutingRequestContext,
    cls: TaskClassification,
    policy: RoutingPolicyState,
    now: number,
  ): { pool: SyncedModelEntry[]; skippedCoolingModels: string[] } {
    const excluded = new Set([...(ctx.excludeTargetIds ?? []), ...policy.blockedModels]);
    const allChat = this.opts.pool.listChatCandidates(now);
    const skippedCoolingModels: string[] = [];
    let pool = allChat.filter((e) => {
      if (excluded.has(e.targetId) || excluded.has(e.rawModelId)) return false;
      if (!this.opts.pool.isModelAvailable(e.targetId, now)) {
        skippedCoolingModels.push(e.rawModelId);
        return false;
      }
      return true;
    });
    if (pool.length === 0 && allChat.length > 0) {
      pool = allChat.filter((e) => !excluded.has(e.targetId) && !excluded.has(e.rawModelId));
    }
    if (pool.length === 0) return { pool, skippedCoolingModels };

    const fitCtx = pool.filter((e) => e.profile.context * 0.85 >= cls.estimatedInputTokens);
    if (fitCtx.length > 0) {
      pool = fitCtx;
    } else {
      const maxCtx = Math.max(...pool.map((e) => e.profile.context));
      pool = pool
        .filter((e) => e.profile.context >= maxCtx * 0.8)
        .sort((a, b) => b.profile.context - a.profile.context);
    }
    if (ctx.hasImages) {
      const vis = pool.filter((e) => e.profile.vision);
      if (vis.length > 0) pool = vis;
    }
    if (ctx.hasTools !== false) {
      const tl = pool.filter((e) => e.profile.tools);
      if (tl.length > 0) pool = tl;
    }
    if (ctx.forceMinTier) {
      const minOrd = TIER_ORDER[ctx.forceMinTier];
      const hi = pool.filter((e) => TIER_ORDER[e.profile.tier] >= minOrd);
      if (hi.length > 0) pool = hi;
    }
    return { pool, skippedCoolingModels };
  }

  planRoute(ctx: RoutingRequestContext): RouteDecisionPlan | undefined {
    const now = this.nowMs();
    const policy = this.opts.experience.getPolicy();
    const cls = classifyTaskArchetype(ctx);
    const { pool, skippedCoolingModels } = this.pruneCandidates(ctx, cls, policy, now);
    if (pool.length === 0) {
      const fb = this.opts.getFallbackEndpoint?.();
      if (!fb) return undefined;
      const primary: ResolvedRouteEndpoint = {
        targetId: `default/${fb.model}`, providerId: "default", rawModelId: fb.model,
        baseUrl: fb.baseUrl, apiKey: fb.apiKey, tier: "balanced", family: "other", thoughtSignatureRequired: false,
      };
      return {
        decisionId: `rt-${crypto.randomBytes(4).toString("hex")}`, archetype: cls.archetype,
        classification: cls, mode: policy.mode, strategy: policy.strategy, primary,
        infraFallbacks: [], reasonSummary: `回退默认配置 ${fb.model}`, skippedCoolingModels, scoredCandidates: [],
      };
    }

    const budget = this.opts.localBudgets?.getBotBudgetStatus(ctx.botId ?? "default", now);
    const w = { ...STRATEGY_WEIGHTS[policy.strategy] };
    const costMult = budget?.enabled && budget.exhausted ? 2.0 : budget?.enabled && budget.lowReserve ? 1.5 : 1.0;
    const totalSamples = this.opts.experience.getTotalArchetypeSamples(cls.archetype, now);
    const scored = pool
      .map((entry) => ({ entry, breakdown: this.scoreEntry(entry, cls.archetype, policy, totalSamples, w, costMult, now) }))
      .sort((a, b) => b.breakdown.totalScore - a.breakdown.totalScore);

    let primaryEntry = scored[0]!.entry;
    let shadowRecommendedTargetId: string | undefined;
    if (policy.mode === "pinned" && policy.pinnedModel) {
      const pinHit = pool.find((e) => e.targetId === policy.pinnedModel || e.rawModelId === policy.pinnedModel);
      if (pinHit) primaryEntry = pinHit;
    } else if (policy.mode === "shadow") {
      shadowRecommendedTargetId = scored[0]!.entry.targetId;
      const roleKey = ctx.role === "computer_use" ? "computerUse" : ctx.role;
      const defSpec = this.opts.providers.routing[roleKey] || this.opts.providers.routing.steward || this.opts.providers.getDefaultProvider()?.defaultModel || "";
      const defTarget = this.opts.providers.resolveModelTarget(defSpec);
      const safeHit = pool.find((e) => e.providerId === defTarget.provider?.id && e.rawModelId === defTarget.model)
        ?? pool.find((e) => e.rawModelId === defTarget.model || e.targetId === defSpec);
      if (safeHit) primaryEntry = safeHit;
    }
    const primary = this.toEndpoint(primaryEntry);
    if (!primary) return undefined;

    const rem = scored.filter((s) => s.entry.targetId !== primary.targetId);
    const infraFallbacks = [...rem.filter((s) => s.entry.profile.family !== primary.family), ...rem.filter((s) => s.entry.profile.family === primary.family)]
      .map((s) => this.toEndpoint(s.entry))
      .filter((x): x is ResolvedRouteEndpoint => Boolean(x))
      .slice(0, 2);
    const pOrd = TIER_ORDER[primaryEntry.profile.tier];
    const minEscOrd = Math.max(pOrd + 1, TIER_ORDER.frontier);
    const escEntry =
      rem.find((s) => TIER_ORDER[s.entry.profile.tier] >= minEscOrd)?.entry ??
      rem.find((s) => TIER_ORDER[s.entry.profile.tier] > pOrd)?.entry ??
      rem.find((s) => s.entry.profile.priorQuality > primaryEntry.profile.priorQuality)?.entry;
    const escalationTarget = escEntry ? this.toEndpoint(escEntry) : undefined;
    const topPost = this.opts.experience.getPosterior(cls.archetype, primary.targetId, primaryEntry.profile.priorQuality, now);
    const reasonSummary = `自动路由：${primary.rawModelId}（${cls.archetype} · 后验${Math.round(topPost.posteriorQuality * 100)}%${skippedCoolingModels.length ? ` · 跳过冷却 ${skippedCoolingModels.slice(0, 2).join(",")}` : ""}）`;
    const decisionId = `rt-${crypto.randomBytes(4).toString("hex")}`;
    const atIso = new Date(now).toISOString();
    this.opts.experience.recordDecision({
      decisionId, atIso, atMs: now, archetype: cls.archetype, mode: policy.mode, strategy: policy.strategy,
      selectedTargetId: primary.targetId, rawModelId: primary.rawModelId, providerId: primary.providerId,
      ...(shadowRecommendedTargetId ? { shadowRecommendedTargetId } : {}), reasonSummary,
      score: Number((scored.find((s) => s.entry.targetId === primary.targetId)?.breakdown.totalScore ?? 0).toFixed(3)),
      fallbackTargets: infraFallbacks.map((f) => f.targetId), ...(escalationTarget ? { escalationTarget: escalationTarget.targetId } : {}),
      skippedCoolingModels, userTextPreview: ctx.text.slice(0, 60),
    });
    this.opts.causalLedger?.append({ roundId: decisionId, kind: "round_triggered", at: atIso, title: `路由 · ${primary.rawModelId}`, source: "adaptive_router", eventType: cls.archetype });
    this.opts.causalLedger?.append({ roundId: decisionId, kind: "worker_claimed", at: atIso, workerId: "adaptive-router", modelRole: ctx.role, resolvedModelId: primary.targetId, summary: reasonSummary });
    return { decisionId, archetype: cls.archetype, classification: cls, mode: policy.mode, strategy: policy.strategy, primary, infraFallbacks, escalationTarget, shadowRecommendedTargetId, reasonSummary, skippedCoolingModels, scoredCandidates: scored.map((s) => s.breakdown) };
  }

  recordAttemptOutcome(ev: {
    decisionId: string;
    targetId: string;
    archetype: TaskArchetype;
    ok: boolean;
    httpStatus?: number | "timeout" | "network";
    ttftMs?: number;
    totalLatencyMs?: number;
    costUsd?: number;
    toolCallCount?: number;
    toolParseErrorCount?: number;
    emptyReply?: boolean;
    escalatedFrom?: string;
    fallbackUsedFrom?: string;
    signalSource: RoutingOutcomeEvent["signalSource"];
  }): void {
    const now = this.nowMs();
    if (!ev.ok && ev.httpStatus !== undefined) {
      this.opts.pool.recordInfraFailure(ev.targetId, ev.httpStatus, now);
    } else if (ev.ok && !ev.emptyReply) {
      this.opts.pool.recordInfraSuccess(ev.targetId, now);
    }
    this.opts.experience.recordOutcome({
      ...ev,
      escalated: Boolean(ev.escalatedFrom),
      atMs: now,
    });
    if (ev.ok && (ev.escalatedFrom || ev.fallbackUsedFrom)) {
      const bare = ev.targetId.includes("/")
        ? ev.targetId.slice(ev.targetId.indexOf("/") + 1)
        : ev.targetId;
      this.opts.experience.updateDecisionOutcome(ev.decisionId, {
        selectedTargetId: ev.targetId,
        rawModelId: bare,
        ...(ev.escalatedFrom ? { escalatedFrom: ev.escalatedFrom } : {}),
        ...(ev.fallbackUsedFrom ? { fallbackUsedFrom: ev.fallbackUsedFrom } : {}),
      });
    }
  }

  recordVibeGateFeedback(passed: boolean, targetId?: string, decisionId?: string): void {
    const fallbackDec = this.opts.experience.getRecentDecisions(1)[0];
    const resolvedTarget = targetId || fallbackDec?.selectedTargetId;
    if (!resolvedTarget) return;
    this.opts.experience.recordOutcome({
      decisionId: decisionId || fallbackDec?.decisionId || `vibe-${this.nowMs()}`,
      targetId: resolvedTarget,
      archetype: "coding_and_review",
      ok: passed,
      signalSource: passed ? "vibe_gate_pass" : "vibe_gate_fail",
      atMs: this.nowMs(),
    });
  }

  getDashboardSnapshot(): AdaptiveRoutingDashboardSnapshot {
    const policy = this.opts.experience.getPolicy();
    const now = this.nowMs();
    return {
      mode: policy.mode,
      strategy: policy.strategy,
      ...(policy.pinnedModel ? { pinnedModel: policy.pinnedModel } : {}),
      pool: this.opts.pool.getPoolSnapshot(now),
      policy,
      recentDecisions: this.opts.experience.getRecentDecisions(20),
      leaderboard: this.opts.experience.getLeaderboardByArchetype(now),
    };
  }
}
