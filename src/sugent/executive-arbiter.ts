/**
 * 统一执行仲裁器与工具可靠性账本（src/sugent/executive-arbiter.ts）
 *
 * 严格遵守内核纯度铁律：
 * - 零文件 I/O、零网络请求、零系统时钟读取、零随机数调用；
 * - 零模型供应商或即时通信平台名称硬编码；
 * - 用主人时间窗、本地美元预算、TrustTier 风险门与工具历史可靠度替换拟人情绪疲劳隐喻。
 */
import type { FocusGravityLane } from "./clarification-gate.js";
import type { BotBudgetStatus } from "./local-budget.js";
import type { CadenceBudgetState, OwnerFlowContext } from "./proactive-cadence.js";
import type { EvolutionRiskLevel } from "./self-evolution.js";
import type { TrustTier } from "./stewardship-ledger.js";
import type { EvalDecision, ModelRole } from "./types.js";

export const MAX_DELIBERATION_PER_GOAL = 3;
export const DELIBERATION_COOLDOWN_SECONDS = 300;
export const COLD_START_SAMPLES = 5;

const EMA_ALPHA = 0.1;
const DECAY_PER_DAY = 0.95;
const NEUTRAL_SCORE = 0.5;
const SCORE_FLOOR = -0.5;
const SCORE_CEIL = 1.0;

export type ToolErrorCategory = "TRANSIENT" | "NOT_FOUND" | "POLICY";

export interface ToolReliabilityRecord {
  toolKey: string;
  emaScore: number;
  sampleCount: number;
  policyBlockCount: number;
  lastCategory?: ToolErrorCategory;
  updatedAtIso: string;
}

export interface ExecutionBudgetContext {
  evalDecision: Pick<EvalDecision, "outcome" | "recommendedRole">;
  trustTier: TrustTier;
  riskLevel: EvolutionRiskLevel;
  focusLane?: FocusGravityLane;
  activeNorthStarSlotCount?: number;
  budgetStatus: Pick<BotBudgetStatus, "enabled" | "lowReserve" | "exhausted">;
  cadenceState: Pick<CadenceBudgetState, "quietHoursActive">;
  flowContext?: OwnerFlowContext;
  activeOwnerTimeWindow: boolean;
  goalId?: string;
  recentDeliberationsForGoal: number;
  cooldownRemainingSec: number;
  toolReliability?: ToolReliabilityRecord;
}

export type ArbitrationAction =
  | "ALLOW_EXECUTE"
  | "DOWNGRADE_TO_ASSESSOR"
  | "SUSPEND_FOR_APPROVAL"
  | "HOLD_AT_FLOW_BOUNDARY"
  | "DEFER_TO_MORNING_DIGEST"
  | "HALT_COOLDOWN_OR_BUDGET";

export interface ArbitrationVerdict {
  action: ArbitrationAction;
  recommendedRole: ModelRole;
  reasonCode: string;
  retryAfterSec?: number;
}

const MS_PER_DAY = 86_400_000;

function clampReliability(value: number): number {
  if (!Number.isFinite(value)) return NEUTRAL_SCORE;
  return Math.max(SCORE_FLOOR, Math.min(SCORE_CEIL, Math.round(value * 10000) / 10000));
}

export function updateToolReliabilityEma(
  prev: ToolReliabilityRecord | undefined,
  toolKey: string,
  succeeded: boolean,
  category: ToolErrorCategory | undefined,
  nowIso: string,
): ToolReliabilityRecord {
  const base: ToolReliabilityRecord = prev ?? {
    toolKey,
    emaScore: NEUTRAL_SCORE,
    sampleCount: 0,
    policyBlockCount: 0,
    updatedAtIso: nowIso,
  };

  if (!succeeded && category === "POLICY") {
    return {
      ...base,
      policyBlockCount: base.policyBlockCount + 1,
      lastCategory: "POLICY",
      updatedAtIso: nowIso,
    };
  }

  let decayedScore = base.emaScore;
  const prevMs = Date.parse(base.updatedAtIso);
  const nowMs = Date.parse(nowIso);
  if (Number.isFinite(prevMs) && Number.isFinite(nowMs) && nowMs > prevMs) {
    const days = (nowMs - prevMs) / MS_PER_DAY;
    const decay = Math.pow(DECAY_PER_DAY, days);
    decayedScore = NEUTRAL_SCORE + (decayedScore - NEUTRAL_SCORE) * decay;
  }

  const target = succeeded ? 1.0 : category === "NOT_FOUND" ? -0.3 : -1.0;
  const nextScore = clampReliability(decayedScore * (1 - EMA_ALPHA) + target * EMA_ALPHA);

  return {
    toolKey,
    emaScore: nextScore,
    sampleCount: base.sampleCount + 1,
    policyBlockCount: base.policyBlockCount,
    ...(succeeded ? {} : { lastCategory: category ?? "TRANSIENT" }),
    updatedAtIso: nowIso,
  };
}

export function evaluateExecutionBudgetGate(ctx: ExecutionBudgetContext): ArbitrationVerdict {
  const defaultRole: ModelRole = ctx.evalDecision.recommendedRole ?? "executor";

  if (ctx.recentDeliberationsForGoal >= MAX_DELIBERATION_PER_GOAL && ctx.cooldownRemainingSec > 0) {
    return {
      action: "HALT_COOLDOWN_OR_BUDGET",
      recommendedRole: "assessor",
      reasonCode: "DELIBERATION_LOOP_COOLDOWN",
      retryAfterSec: Math.max(1, Math.trunc(ctx.cooldownRemainingSec)),
    };
  }

  if (ctx.budgetStatus.enabled && ctx.budgetStatus.exhausted) {
    return {
      action: "HALT_COOLDOWN_OR_BUDGET",
      recommendedRole: "assessor",
      reasonCode: "LOCAL_BUDGET_EXHAUSTED",
    };
  }

  if (ctx.riskLevel === "forbidden" || (ctx.trustTier !== "L3_shadow_autonomous" && ctx.riskLevel !== "autonomous")) {
    return {
      action: "SUSPEND_FOR_APPROVAL",
      recommendedRole: defaultRole,
      reasonCode: ctx.riskLevel === "forbidden" ? "RISK_FORBIDDEN" : "TRUST_TIER_REQUIRES_APPROVAL",
    };
  }

  if (ctx.focusLane === "icebox" && (ctx.activeNorthStarSlotCount ?? 0) > 0) {
    return {
      action: "DEFER_TO_MORNING_DIGEST",
      recommendedRole: "assessor",
      reasonCode: "ICEBOX_DEFERRED_FOR_NORTH_STAR",
    };
  }

  if (
    ctx.flowContext?.mode === "deep_focus" &&
    ctx.flowContext.activeGoalId &&
    ctx.goalId !== ctx.flowContext.activeGoalId &&
    (ctx.flowContext.flowStrength ?? 0.7) >= 0.45
  ) {
    return {
      action: "HOLD_AT_FLOW_BOUNDARY",
      recommendedRole: defaultRole,
      reasonCode: "OFF_GOAL_DURING_DEEP_FOCUS",
    };
  }

  if (ctx.cadenceState.quietHoursActive && !ctx.activeOwnerTimeWindow) {
    return {
      action: "DEFER_TO_MORNING_DIGEST",
      recommendedRole: "assessor",
      reasonCode: "QUIET_HOURS_NON_URGENT",
    };
  }

  if (
    (ctx.budgetStatus.enabled && ctx.budgetStatus.lowReserve) ||
    (ctx.toolReliability &&
      ctx.toolReliability.sampleCount >= COLD_START_SAMPLES &&
      ctx.toolReliability.emaScore < 0)
  ) {
    return {
      action: "DOWNGRADE_TO_ASSESSOR",
      recommendedRole: "assessor",
      reasonCode: ctx.budgetStatus.lowReserve ? "LOW_BUDGET_RESERVE" : "LOW_TOOL_RELIABILITY_EMA",
    };
  }

  return {
    action: "ALLOW_EXECUTE",
    recommendedRole: defaultRole,
    reasonCode: "ARBITRATION_CLEARED",
  };
}