import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AcpCodingHarness,
  DualTrackCodingBudget,
  buildSafeAcpCliArgv,
  runCrossAgentCodingLoop,
} from "../src/sugent/acp-coding-harness.js";
import { CodingHarnessRegistry } from "../src/sugent/repo-binding.js";

describe("Wave P1.2 Standard ACP External Agent Harness & Dual-Track Budget", () => {
  const tmpDirs: string[] = [];
  function mkTmp(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tmpDirs.length > 0) {
      fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("builds safe argv vectors for claude_code, codex, opencode, and pi without permission-bypass flags", () => {
    for (const backend of ["claude_code", "codex", "opencode", "pi"] as const) {
      const spec = buildSafeAcpCliArgv(backend, { workspacePath: "/tmp/demo" });
      expect(spec.argv.length).toBeGreaterThanOrEqual(1);
      const joined = spec.argv.join(" ");
      expect(joined).not.toContain("dangerously-skip-permissions");
      expect(joined).not.toContain("danger-full-access");
      expect(joined).not.toContain("--full-auto");
    }
  });

  it("speaks ACP v1 newline-delimited JSON-RPC 2.0 (initialize -> session/new -> session/prompt) over stdio and registers in CodingHarnessRegistry", async () => {
    const ws = mkTmp("sugent-acp-stdio-");
    const mockAgentScript = path.join(ws, "mock-acp-agent.mjs");
    fs.writeFileSync(
      mockAgentScript,
      [
        'let buf = "";',
        'process.stdin.setEncoding("utf8");',
        'process.stdin.on("data", (chunk) => {',
        '  buf += chunk;',
        '  let idx;',
        '  while ((idx = buf.indexOf("\\n")) >= 0) {',
        '    const line = buf.slice(0, idx).trim();',
        '    buf = buf.slice(idx + 1);',
        '    if (!line) continue;',
        '    const msg = JSON.parse(line);',
        '    if (msg.method === "initialize") {',
        '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "mock-acp", version: "1.0.0" } } }) + "\\n");',
        '    } else if (msg.method === "session/new") {',
        '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess_acp_001" } }) + "\\n");',
        '    } else if (msg.method === "session/prompt") {',
        '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess_acp_001", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Implemented payment signature check." } } } }) + "\\n");',
        '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }) + "\\n");',
        '      process.exit(0);',
        '    }',
        '  }',
        '});',
      ].join("\n"),
    );

    const harness = new AcpCodingHarness({
      backend: "opencode",
      resolveCommand: () => ({ argv: [process.execPath, mockAgentScript] }),
    });
    const registry = new CodingHarnessRegistry([harness]);
    expect(registry.listBackends()).toContain("opencode");

    const out = await harness.dispatchPhasePrompt({
      workspacePath: ws,
      title: "Add payment check",
      prompt: "Please add signature verification\u2028with safe line handling.",
    });

    expect(out.ok).toBe(true);
    expect(out.conversationId).toBe("sess_acp_001");
    expect(out.message).toContain("Implemented payment signature check.");
  });

  it("tracks API USD separately from subscription frequency/cooldown quota and orchestrates Coder A + Gate + Reviewer B", async () => {
    const budget = new DualTrackCodingBudget({
      apiUsdDailyCap: 5,
      subscriptionMaxTurnsPerWindow: 2,
      subscriptionWindowMs: 60_000,
    });

    budget.recordApiUsageUsd("codex", 1.25, 1_000);
    expect(budget.snapshot(1_000).apiUsdSpent).toBeCloseTo(1.25, 4);
    expect(budget.canDispatchSubscription("claude_code", 1_000).allowed).toBe(true);

    budget.recordSubscriptionTurn("claude_code", 1_000);
    budget.recordSubscriptionTurn("claude_code", 2_000);
    const throttled = budget.canDispatchSubscription("claude_code", 3_000);
    expect(throttled.allowed).toBe(false);
    expect(throttled.retryAfterMs).toBeGreaterThan(0);

    // After window expires, subscription quota recovers
    expect(budget.canDispatchSubscription("claude_code", 65_000).allowed).toBe(true);

    // Coder A + Independent Gate + Reviewer B loop
    const steps: string[] = [];
    const loopRes = await runCrossAgentCodingLoop({
      workspacePath: "/tmp/ws",
      title: "Fix retry bug",
      coderPrompt: "Implement bounded retry",
      coderHarness: {
        backend: "claude_code",
        async dispatchPhasePrompt() {
          steps.push("coder:claude_code");
          return { ok: true, roundId: "r-1", hopCount: 1, maxHops: 8, conversationId: "s-coder", message: "Patched retry.ts" };
        },
      },
      runGate: async () => {
        steps.push("gate:independent");
        return { passed: true, summary: "vitest 12/12 passed" };
      },
      reviewerHarness: {
        backend: "codex",
        async dispatchPhasePrompt() {
          steps.push("reviewer:codex");
          return { ok: true, roundId: "r-2", hopCount: 2, maxHops: 8, conversationId: "s-rev", message: "Verdict: Approve" };
        },
      },
    });

    expect(loopRes.ok).toBe(true);
    expect(loopRes.gatePassed).toBe(true);
    expect(loopRes.reviewApproved).toBe(true);
    expect(steps).toEqual(["coder:claude_code", "gate:independent", "reviewer:codex"]);
  });
});
