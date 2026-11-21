import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SugentSIMStore } from "../src/sugent/self-improvement-memory.js";
import {
  SANDBOX_INITIAL_CONFIDENCE,
  URGENT_SURPRISE_THRESHOLD,
  advanceSandboxHypothesis,
  canMergeContactIdentities,
  computeSurpriseMomentum,
  profilePeerLanguage,
  runGardenerCycle,
  selectGardenerCostTier,
  type GardenerSandboxHypothesis,
} from "../src/sugent/memory-gardener.js";
import {
  ensureSelfEvolutionOverlay,
  listQuarantinedArtifacts,
  listSelfEvolutionPlugins,
  quarantineSelfEvolutionArtifact,
  restoreQuarantinedArtifact,
} from "../src/sugent/self-evolution.js";

const tmpDirs: string[] = [];
function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-sim-gardener-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("SugentSIMStore (arXiv:2611.18856) & Surgical Quarantine", () => {
  it("flags model_specific edits on BYOK switch while keeping interface_invariant, and quarantines only the regressed plugin", () => {
    const dir = mkTmp();
    const overlayDir = ensureSelfEvolutionOverlay(dir, path.join(dir, "app.asar"));
    const pluginsDir = path.join(overlayDir, "plugins");
    fs.writeFileSync(path.join(pluginsDir, "sugent-ext-bad.mjs"), "export const name = 'bad';\n");
    fs.writeFileSync(path.join(pluginsDir, "sugent-ext-bad.json"), JSON.stringify({ id: "sugent-ext-bad", apiVersion: 1 }));
    fs.writeFileSync(path.join(pluginsDir, "sugent-ext-good.mjs"), "export const name = 'good';\n");
    fs.writeFileSync(path.join(pluginsDir, "sugent-ext-good.json"), JSON.stringify({ id: "sugent-ext-good", apiVersion: 1 }));

    const sim = new SugentSIMStore(dir);
    sim.recordAttempt(
      { problemId: "P-EXEC-001", title: "Premature edit loop" },
      {
        attemptId: "att-1",
        roundId: "r-1",
        atIso: "2026-11-21T08:00:00Z",
        artifactKind: "cordis_plugin",
        artifactPathOrId: "sugent-ext-bad",
        portabilityClass: "model_specific",
        rationale: "Force model A verification nudge",
        hypothesis: "Reduces skipped tests",
        accepted: true,
        revalidationStatus: "verified",
        outcomeDelta: { predictedOutcomes: ["t1"], fixed: ["t1"], missed: [], baselinePassRate: 0.8, postEditPassRate: 0.85, ownerRejectedCount: 0, regressionDetected: false },
        provenance: { modelRole: "executor", resolvedModelId: "model-opus-old" },
      },
    );
    sim.recordAttempt(
      { problemId: "P-INV-001", title: "Invariant shell safety" },
      {
        attemptId: "att-2",
        roundId: "r-2",
        atIso: "2026-11-21T08:05:00Z",
        artifactKind: "cordis_plugin",
        artifactPathOrId: "sugent-ext-good",
        portabilityClass: "interface_invariant",
        rationale: "Enforce read-only envelope",
        hypothesis: "Blocks injection",
        accepted: true,
        revalidationStatus: "verified",
        outcomeDelta: { predictedOutcomes: ["s1"], fixed: ["s1"], missed: [], ownerRejectedCount: 0, regressionDetected: false },
        provenance: { modelRole: "executor", resolvedModelId: "model-opus-old" },
      },
    );

    const flagged = sim.flagOnModelSwitch("executor", "model-opus-old", "model-flash-new", "2026-11-21T09:00:00Z");
    expect(flagged.map((a) => a.attemptId)).toEqual(["att-1"]);
    const promptJson = sim.buildOptimizerPromptJson();
    expect(promptJson).toContain("Force model A verification nudge");

    sim.reconcileRoundOutcome("r-1", { postEditPassRate: 0.55, ownerRejectedCount: 2, regressionDetected: true });
    const decision = sim.evaluateRegression("att-1", "2026-11-21T09:10:00Z");
    expect(decision?.shouldQuarantine).toBe(true);
    expect(decision?.tombstoneStatement).toContain("P-EXEC-001");

    quarantineSelfEvolutionArtifact(dir, {
      kind: "plugin",
      idOrName: decision!.artifactPathOrId,
      reason: decision!.reason,
      simAttemptId: "att-1",
      atIso: "2026-11-21T09:10:00Z",
    });
    expect(listSelfEvolutionPlugins(dir).map((p) => p.id)).toEqual(["sugent-ext-good"]);
    expect(listQuarantinedArtifacts(dir).map((q) => q.idOrName)).toEqual(["sugent-ext-bad"]);
    expect(sim.getQuarantinedIds().has("sugent-ext-bad")).toBe(true);
    expect(restoreQuarantinedArtifact(dir, "plugin", "sugent-ext-bad")).toBe(true);
    expect(listSelfEvolutionPlugins(dir).map((p) => p.id).sort()).toEqual(["sugent-ext-bad", "sugent-ext-good"]);
  });
});

describe("MemoryGardener (DreamSandbox, Titans Surprise, Cost Tiers, LanguageProfiler, MergeGuard)", () => {
  it("validates 3-confirmation sandbox promotion, 7-day expiry, Titans momentum >= 0.7, and MergeGuard >= 2 strong matches", () => {
    let hyp: GardenerSandboxHypothesis = {
      id: "h-1",
      partition: "work_project",
      targetKind: "tombstone",
      statement: "禁止跳过单测强推",
      state: "PROPOSED",
      confidence: SANDBOX_INITIAL_CONFIDENCE,
      confirmations: 0,
      contradictions: 0,
      createdAtIso: "2026-11-01T00:00:00Z",
      lastEvidenceAtIso: "2026-11-01T00:00:00Z",
    };
    hyp = advanceSandboxHypothesis(hyp, "confirm", "2026-11-02T00:00:00Z");
    hyp = advanceSandboxHypothesis(hyp, "confirm", "2026-11-03T00:00:00Z");
    expect(hyp.state).toBe("PROPOSED");
    hyp = advanceSandboxHypothesis(hyp, "confirm", "2026-11-04T00:00:00Z");
    expect(hyp.state).toBe("VALIDATED");

    const expired = advanceSandboxHypothesis(
      { ...hyp, state: "PROPOSED", confirmations: 0, lastEvidenceAtIso: "2026-11-01T00:00:00Z" },
      undefined,
      "2026-11-10T00:00:00Z",
    );
    expect(expired.state).toBe("DISCARDED");

    const mom = computeSurpriseMomentum(0.65, 0.9, 0.7);
    expect(mom).toBeGreaterThanOrEqual(URGENT_SURPRISE_THRESHOLD);
    expect(selectGardenerCostTier(0.1)).toBe("tier0_deterministic");
    expect(selectGardenerCostTier(0.35)).toBe("tier1_template");
    expect(selectGardenerCostTier(0.8)).toBe("tier2_steward_llm");

    const taste = profilePeerLanguage("rel-1", "work_project", ["您好，附件报价请查收。", "烦请确认周期。"]);
    expect(taste?.formalityScore).toBeGreaterThanOrEqual(0.65);
    expect(taste?.suggestedPreferences.some((p) => p.includes("短句"))).toBe(true);

    expect(canMergeContactIdentities({ channel: "weixin", displayName: "张总", phone: "13800001111" }, { channel: "feishu", displayName: "张总", phone: "13800001111" }).canMerge).toBe(false);
    expect(canMergeContactIdentities({ channel: "weixin", displayName: "张总", phone: "13800001111", email: "z@acme.com" }, { channel: "feishu", displayName: "张伟", phone: "13800001111", email: "z@acme.com" }).canMerge).toBe(true);

    const out = runGardenerCycle({
      nowIso: "2026-11-21T12:00:00Z",
      ledger: { version: 1, updatedAt: "2026-11-21T00:00:00Z", relationships: [], goals: [], guardrails: [], commitments: [], resources: [] },
      recentRounds: [],
      hypotheses: [{ ...hyp, id: "h-run", state: "PROPOSED", confirmations: 2 }],
      sandboxEvents: { "h-run": "confirm" },
      ruleStats: [{ ruleId: "r-bad", mode: "act", emaEffectiveness: 0.2 }],
      prevSurpriseMomentum: 0.65,
      currentSurprise: 0.9,
      maxStewardTokenBudget: 800,
    });
    expect(out.driftReport.urgentTriggered).toBe(true);
    expect(out.promotedProposals.map((p) => p.id)).toEqual(["h-run"]);
    expect(out.demotedRuleIds).toEqual(["r-bad"]);
  });
});