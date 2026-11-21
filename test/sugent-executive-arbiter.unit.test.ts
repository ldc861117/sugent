import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findAppRoot } from "../src/magpie/supervisor.js";
import {
  DELIBERATION_COOLDOWN_SECONDS,
  MAX_DELIBERATION_PER_GOAL,
  evaluateExecutionBudgetGate,
  updateToolReliabilityEma,
} from "../src/sugent/executive-arbiter.js";

describe("ExecutiveArbiter Purity Gate & Deterministic Arbitration", () => {
  it("enforces zero fs/http/fetch/clock/random/vendor hardcoding in executive-arbiter.ts", () => {
    const raw = fs.readFileSync(path.join(findAppRoot(), "src", "sugent", "executive-arbiter.ts"), "utf8");
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const pat of [
      /\bfetch\s*\(/,
      /\bnode:(?:fs|http|https|net|tls|child_process|dgram|dns)\b/,
      /\bDate\.now\s*\(/,
      /\bnew\s+Date\s*\(/,
      /\bMath\.random\s*\(/,
      /\bcrypto\.random/,
      /\bsetTimeout\s*\(/,
      /\bsetInterval\s*\(/,
    ]) {
      expect(raw).not.toMatch(pat);
      expect(code).not.toMatch(pat);
    }
    for (const vendor of [
      /\bclaude\b/i, /\bcodex\b/i, /\bopenai\b/i, /\banthropic\b/i, /\bdeepseek\b/i,
      /\bgemini\b/i, /\bmodelflare\b/i, /\bfeishu\b/i, /\bweixin\b/i, /\bwechat\b/i,
      /\btelegram\b/i, /\bdiscord\b/i, /\bslack\b/i, /\blark\b/i, /\bdingtalk\b/i,
    ]) {
      expect(raw).not.toMatch(vendor);
    }
  });

  it("does not penalize tool EMA on POLICY blocks while penalizing TRANSIENT failures", () => {
    let rec = updateToolReliabilityEma(undefined, "cli:agentapi", true, undefined, "2026-11-21T09:00:00Z");
    const scoreBeforePolicy = rec.emaScore;
    rec = updateToolReliabilityEma(rec, "cli:agentapi", false, "POLICY", "2026-11-21T09:05:00Z");
    expect(rec.emaScore).toBe(scoreBeforePolicy);
    expect(rec.policyBlockCount).toBe(1);

    rec = updateToolReliabilityEma(rec, "cli:agentapi", false, "TRANSIENT", "2026-11-21T09:10:00Z");
    expect(rec.emaScore).toBeLessThan(scoreBeforePolicy);
  });

  it("arbitrates cooldown halts, trust gating, flow boundaries, icebox deferrals, and low-reserve downgrades", () => {
    const base = {
      evalDecision: { outcome: "accept_act" as const, recommendedRole: "executor" as const },
      trustTier: "L3_shadow_autonomous" as const,
      riskLevel: "autonomous" as const,
      budgetStatus: { enabled: true, lowReserve: false, exhausted: false },
      cadenceState: { quietHoursActive: false },
      activeOwnerTimeWindow: true,
      goalId: "g1",
      recentDeliberationsForGoal: 0,
      cooldownRemainingSec: 0,
    };
    expect(evaluateExecutionBudgetGate({ ...base, recentDeliberationsForGoal: MAX_DELIBERATION_PER_GOAL, cooldownRemainingSec: DELIBERATION_COOLDOWN_SECONDS }).action).toBe("HALT_COOLDOWN_OR_BUDGET");
    expect(evaluateExecutionBudgetGate({ ...base, trustTier: "L2_suspend_approval", riskLevel: "requires_approval" }).action).toBe("SUSPEND_FOR_APPROVAL");
    expect(evaluateExecutionBudgetGate({ ...base, focusLane: "icebox", activeNorthStarSlotCount: 1 }).action).toBe("DEFER_TO_MORNING_DIGEST");
    expect(evaluateExecutionBudgetGate({ ...base, goalId: "g2", flowContext: { mode: "deep_focus", activeGoalId: "g1", flowStrength: 0.9 } }).action).toBe("HOLD_AT_FLOW_BOUNDARY");
    expect(evaluateExecutionBudgetGate({ ...base, budgetStatus: { enabled: true, lowReserve: true, exhausted: false } }).action).toBe("DOWNGRADE_TO_ASSESSOR");
    expect(evaluateExecutionBudgetGate(base).action).toBe("ALLOW_EXECUTE");
  });
});