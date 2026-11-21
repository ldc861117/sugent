import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findAppRoot } from "../src/magpie/supervisor.js";
import { computeEventDelta, scoreEventSalience } from "../src/sugent/salience-gate.js";
import { evaluateClarificationAndFocus } from "../src/sugent/clarification-gate.js";
import { UniversalDropzone, type DropzoneLedgerPort } from "../src/sugent/universal-dropzone.js";

function assertPureModule(relPath: string) {
  const raw = fs.readFileSync(path.join(findAppRoot(), relPath), "utf8");
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
    expect(raw, `${relPath} raw matches ${pat}`).not.toMatch(pat);
    expect(code, `${relPath} code matches ${pat}`).not.toMatch(pat);
  }
  for (const vendor of [
    /\bclaude\b/i, /\bcodex\b/i, /\bopenai\b/i, /\banthropic\b/i, /\bdeepseek\b/i,
    /\bgemini\b/i, /\bmodelflare\b/i, /\bfeishu\b/i, /\bweixin\b/i, /\bwechat\b/i,
    /\btelegram\b/i, /\bdiscord\b/i, /\bslack\b/i, /\blark\b/i, /\bdingtalk\b/i,
  ]) {
    expect(raw, `${relPath} vendor ${vendor}`).not.toMatch(vendor);
  }
}

describe("SalienceGate & ClarificationGate Purity + Logic", () => {
  it("keeps salience-gate.ts and clarification-gate.ts 100% pure", () => {
    assertPureModule("src/sugent/salience-gate.ts");
    assertPureModule("src/sugent/clarification-gate.ts");
  });

  it("drops pure timestamp jitter at 0 LLM tokens and raises threshold on low reserve / quiet hours", () => {
    const d0 = computeEventDelta(
      { status: "running", updatedAtIso: "2026-11-21T10:00:00Z" },
      { status: "running", updatedAtIso: "2026-11-21T10:05:00Z" },
      "repo:sugent",
      300_000,
    );
    expect(d0.magnitude).toBe(0);
    const v0 = scoreEventSalience({
      trigger: { id: "t1", sourceKind: "github", text: "status check", threadKey: "th-1", createdAt: "2026-11-21T10:05:00Z" },
      delta: d0,
      ledger: { goals: [], commitments: [], guardrails: [] },
      cadenceState: { quietHoursActive: false },
      nowIso: "2026-11-21T10:05:00Z",
    });
    expect(v0.route).toBe("drop_noise");

    const d1 = computeEventDelta({ status: "open" }, { status: "blocked" }, "repo:sugent", 60_000);
    const vLow = scoreEventSalience({
      trigger: { id: "t2", sourceKind: "github", text: "交付核心架构", threadKey: "th-2", createdAt: "2026-11-21T10:05:00Z" },
      delta: d1,
      ledger: {
        goals: [{ id: "g1", partition: "work_project", title: "交付核心架构", northStarCriterion: "单测全绿", status: "active", lastProgressAt: "2026-11-21T08:00:00Z", stallThresholdDays: 7 }],
        commitments: [],
        guardrails: [],
      },
      budgetStatus: { enabled: true, lowReserve: true, exhausted: false },
      cadenceState: { quietHoursActive: true },
      nowIso: "2026-11-21T10:05:00Z",
    });
    expect(vLow.effectiveThreshold).toBeCloseTo(0.7, 2);
    expect(vLow.route).toBe("fast_template_digest");
    expect(vLow.templateDigest).toContain("[0-token digest]");
  });

  it("routes random brainstorms to icebox and triggers Recall-Before-Ask clarification on ambiguity or hollow goals", async () => {
    const hollow = evaluateClarificationAndFocus({
      text: "把商业化彻底做大做强",
      intentHint: "goal_proposal",
      recalledContacts: [],
      recalledArchives: [],
      activeGoals: [],
      guardrails: [],
    });
    expect(hollow.status).toBe("needs_clarification");
    expect(hollow.reason).toBe("hollow_goal_criterion");

    const icebox = evaluateClarificationAndFocus({
      text: "突然想研究一下 Rust 渲染引擎",
      intentHint: "capture",
      recalledContacts: [],
      recalledArchives: [],
      activeGoals: [{ id: "g1", title: "交付支付系统", northStarCriterion: "周五上线" }],
      guardrails: [],
    });
    expect(icebox.focusLane).toBe("icebox");

    const rels = [
      { id: "r1", partition: "work_project" as const, name: "张伟", roleTag: "客户A", taboos: [], preferences: ["直接发PDF"], openFavors: [] },
      { id: "r2", partition: "work_project" as const, name: "张强", roleTag: "供应商B", taboos: [], preferences: [], openFavors: [] },
    ];
    const ledgerPort: DropzoneLedgerPort = {
      upsertCommitment: (i) => ({ ...i, id: "c1", status: i.status ?? "open", updatedAt: "2026-11-21T10:00:00Z" }),
      upsertResource: (i) => ({ ...i, id: "res1" }),
      findArchiveResources: () => [{ id: "a1", partition: "work_project", kind: "personal_archive", title: "通用报价模板", localUriOrPath: "/tmp/quote.pdf", metadata: {} }],
      queryContext: () => ({ relationships: [], goals: [], guardrails: [], commitments: [], resources: [] }),
      snapshotForCaller: () => ({ relationships: rels, goals: [{ id: "g1", title: "保毛利", northStarCriterion: "毛利>=40%", status: "active" }], guardrails: [] }),
    };
    const dz = new UniversalDropzone({ ledger: ledgerPort });

    const clarOut = await dz.handle({
      inputId: "in-ambig",
      channel: "weixin",
      partition: "work_project",
      callerDomain: "owner_private",
      text: "帮我给老张发一下正式报价单",
      receivedAtIso: "2026-11-21T10:00:00Z",
    });
    expect(clarOut.intent).toBe("clarify");
    if (clarOut.intent !== "clarify") throw new Error("expected clarify");
    expect(clarOut.reason).toBe("ambiguous_counterparty_or_slot");
    expect(clarOut.options[0]).toContain("张伟");
    expect(clarOut.options[1]).toContain("张强");

    const cappedOut = await dz.handle({
      inputId: "in-capped",
      channel: "weixin",
      partition: "work_project",
      callerDomain: "owner_private",
      text: "帮我给老张整理一份报销附件",
      priorClarificationTurns: 2,
      receivedAtIso: "2026-11-21T10:02:00Z",
    });
    expect(cappedOut.intent).toBe("delegate");
  });
});