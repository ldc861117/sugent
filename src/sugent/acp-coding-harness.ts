import { spawn } from "node:child_process";
import path from "node:path";
import type { DispatchOutcome } from "./antigravity-dispatcher.js";
import { assertSafeDeliveryCommandVector } from "./delivery.js";
import { DEFAULT_MAX_HOPS } from "./kernel.js";
import type { CodingBackendKind, CodingDispatchRequest, CodingHarnessPort } from "./repo-binding.js";

export type AcpBackendKind = Exclude<CodingBackendKind, "antigravity">;

export interface AcpCliCommandSpec {
  argv: string[];
  env?: Record<string, string>;
}

const FORBIDDEN_CLI_FLAGS = [
  "--dangerously-skip-permissions",
  "danger-full-access",
  "--full-auto",
] as const;

/**
 * Builds strictly sandboxed, permission-respecting ACP stdio CLI vectors
 * verified against Agent Client Protocol v1 specifications:
 * - Claude Code: `@agentclientprotocol/claude-agent-acp`
 * - Codex: `@agentclientprotocol/codex-acp` (`INITIAL_AGENT_MODE=workspace-write`)
 * - OpenCode: native `opencode acp --cwd <dir>`
 * - Pi: `pi-acp`
 */
export function buildSafeAcpCliArgv(
  backend: AcpBackendKind,
  opts: { workspacePath: string; readOnly?: boolean; customBinary?: string },
): AcpCliCommandSpec {
  const cwd = path.resolve(opts.workspacePath);
  let argv: string[];
  let env: Record<string, string> | undefined;

  switch (backend) {
    case "claude_code":
      argv = opts.customBinary
        ? [opts.customBinary]
        : ["npx", "-y", "@agentclientprotocol/claude-agent-acp"];
      env = { CLAUDE_AGENT_ACP_PROTOCOL: "v1" };
      break;
    case "codex":
      argv = opts.customBinary
        ? [opts.customBinary]
        : ["npx", "-y", "@agentclientprotocol/codex-acp"];
      env = { INITIAL_AGENT_MODE: opts.readOnly ? "read-only" : "workspace-write" };
      break;
    case "opencode":
      argv = [opts.customBinary || "opencode", "acp", "--cwd", cwd];
      break;
    case "pi":
      argv = opts.customBinary ? [opts.customBinary] : ["npx", "-y", "pi-acp"];
      break;
  }

  for (const token of argv) {
    for (const banned of FORBIDDEN_CLI_FLAGS) {
      if (token.includes(banned)) {
        throw new Error(`Forbidden unsafe CLI flag rejected: ${token}`);
      }
    }
  }
  return { argv: [...assertSafeDeliveryCommandVector(argv)], ...(env ? { env } : {}) };
}

export interface AcpCodingHarnessOptions {
  backend: AcpBackendKind;
  timeoutMs?: number;
  readOnly?: boolean;
  resolveCommand?: (opts: { workspacePath: string; readOnly?: boolean }) => AcpCliCommandSpec;
  onPermissionRequest?: (params: {
    sessionId: string;
    options?: Array<{ optionId: string; kind?: string }>;
  }) => Promise<{ outcome: "selected"; optionId: string } | { outcome: "cancelled" }>;
}

/**
 * Standard Agent Client Protocol (ACP v1, `protocolVersion: 1`) stdio JSON-RPC 2.0 client.
 * Uses strict `\n` (LF) framing (never splitting on Unicode U+2028/U+2029 inside JSON strings).
 */
export class AcpCodingHarness implements CodingHarnessPort {
  readonly backend: AcpBackendKind;
  private readonly timeoutMs: number;
  private readonly readOnly: boolean;
  private readonly resolveCommandFn: NonNullable<AcpCodingHarnessOptions["resolveCommand"]>;
  private readonly onPermissionRequest?: AcpCodingHarnessOptions["onPermissionRequest"];

  constructor(opts: AcpCodingHarnessOptions) {
    this.backend = opts.backend;
    this.timeoutMs = Math.max(1_000, opts.timeoutMs ?? 120_000);
    this.readOnly = Boolean(opts.readOnly);
    this.resolveCommandFn =
      opts.resolveCommand ??
      ((i) => buildSafeAcpCliArgv(opts.backend, { workspacePath: i.workspacePath, readOnly: i.readOnly }));
    this.onPermissionRequest = opts.onPermissionRequest;
  }

  async dispatchPhasePrompt(input: CodingDispatchRequest): Promise<DispatchOutcome> {
    const hop = Math.max(0, Math.trunc(input.hopCount ?? 0));
    const roundId = `acp-${this.backend}-${Date.now().toString(36)}`;
    if (hop >= DEFAULT_MAX_HOPS) {
      return {
        ok: false,
        roundId,
        hopCount: hop,
        maxHops: DEFAULT_MAX_HOPS,
        errorCode: "HOP_CIRCUIT_BROKEN",
        message: `Hop count ${hop} reached safety ceiling ${DEFAULT_MAX_HOPS}`,
      };
    }

    const cwd = path.resolve(input.workspacePath);
    const cmdSpec = this.resolveCommandFn({ workspacePath: cwd, readOnly: this.readOnly });
    const safeArgv = assertSafeDeliveryCommandVector(cmdSpec.argv);

    return new Promise<DispatchOutcome>((resolve) => {
      let settled = false;
      const chunks: string[] = [];
      const stderrChunks: string[] = [];
      let sessionId = input.conversationId?.trim() || "";
      let nextRpcId = 1;
      const pending = new Map<
        number,
        { resolve: (val: Record<string, unknown>) => void; reject: (err: Error) => void }
      >();

      const child = spawn(safeArgv[0]!, safeArgv.slice(1), {
        cwd,
        env: { ...process.env, ...(cmdSpec.env ?? {}) },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const finish = (outcome: DispatchOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          child.stdin.end();
        } catch {
          // ignore
        }
        try {
          if (!child.killed) child.kill("SIGTERM");
        } catch {
          // ignore
        }
        resolve(outcome);
      };

      const timer = setTimeout(() => {
        if (sessionId) {
          sendNotification("session/cancel", { sessionId });
        }
        finish({
          ok: false,
          roundId,
          hopCount: hop + 1,
          maxHops: DEFAULT_MAX_HOPS,
          ...(sessionId ? { conversationId: sessionId } : {}),
          errorCode: "AGENTAPI_FAILED",
          message: `ACP_TIMEOUT: turn timed out after ${this.timeoutMs}ms`,
        });
      }, this.timeoutMs);

      const sendRawLine = (payload: Record<string, unknown>) => {
        // JSON.stringify escapes \n inside strings; replace literal U+2028/U+2029 for strict single-line safety
        const serialized = JSON.stringify(payload)
          .replace(/\u2028/g, "\\u2028")
          .replace(/\u2029/g, "\\u2029");
        child.stdin.write(`${serialized}\n`, "utf8");
      };

      const sendRequest = (method: string, params: Record<string, unknown>) => {
        const id = nextRpcId++;
        return new Promise<Record<string, unknown>>((res, rej) => {
          pending.set(id, { resolve: res, reject: rej });
          sendRawLine({ jsonrpc: "2.0", id, method, params });
        });
      };

      const sendNotification = (method: string, params: Record<string, unknown>) => {
        sendRawLine({ jsonrpc: "2.0", method, params });
      };

      let stdoutBuf = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (piece: string) => {
        stdoutBuf += piece;
        let lfIdx: number;
        // Strictly split on LF (\n = 0x0A), never on U+2028/U+2029
        while ((lfIdx = stdoutBuf.indexOf("\n")) >= 0) {
          const rawLine = stdoutBuf.slice(0, lfIdx).replace(/\r$/, "").trim();
          stdoutBuf = stdoutBuf.slice(lfIdx + 1);
          if (!rawLine) continue;
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(rawLine) as Record<string, unknown>;
          } catch {
            continue;
          }

          if (typeof msg.id === "number" && ("result" in msg || "error" in msg)) {
            const waiter = pending.get(msg.id);
            if (waiter) {
              pending.delete(msg.id);
              if (msg.error) {
                waiter.reject(new Error(JSON.stringify(msg.error)));
              } else {
                waiter.resolve((msg.result as Record<string, unknown>) ?? {});
              }
            }
            continue;
          }

          if (msg.method === "session/update") {
            const params = (msg.params ?? {}) as {
              update?: { sessionUpdate?: string; content?: { type?: string; text?: string } };
            };
            if (
              params.update?.sessionUpdate === "agent_message_chunk" &&
              typeof params.update.content?.text === "string"
            ) {
              chunks.push(params.update.content.text);
            }
            continue;
          }

          if (msg.method === "session/request_permission" && (typeof msg.id === "number" || typeof msg.id === "string")) {
            const reqId = msg.id;
            const params = (msg.params ?? {}) as {
              sessionId?: string;
              options?: Array<{ optionId: string; kind?: string }>;
            };
            void (async () => {
              let outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } = {
                outcome: "cancelled",
              };
              if (this.onPermissionRequest) {
                outcome = await this.onPermissionRequest({
                  sessionId: params.sessionId ?? sessionId,
                  options: params.options,
                });
              }
              sendRawLine({ jsonrpc: "2.0", id: reqId, result: { outcome } });
            })();
          }
        }
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderrChunks.push(chunk);
      });

      child.on("error", (err) => {
        finish({
          ok: false,
          roundId,
          hopCount: hop + 1,
          maxHops: DEFAULT_MAX_HOPS,
          errorCode: "AGENTAPI_FAILED",
          message: `ACP_SPAWN_FAILED: ${err.message}`,
        });
      });

      child.on("close", (code) => {
        if (!settled) {
          for (const [, w] of pending) {
            w.reject(new Error(`ACP process exited early with code ${String(code)}`));
          }
          pending.clear();
          finish({
            ok: false,
            roundId,
            hopCount: hop + 1,
            maxHops: DEFAULT_MAX_HOPS,
            errorCode: "AGENTAPI_FAILED",
            message: stderrChunks.join("").trim().slice(-400) || `ACP_EXITED_EARLY (${String(code)})`,
          });
        }
      });

      void (async () => {
        try {
          const initRes = await sendRequest("initialize", {
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            clientInfo: { name: "sugent-steward", title: "Sugent Steward", version: "0.1.15" },
          });

          const agentCaps = (initRes.agentCapabilities ?? {}) as { loadSession?: boolean };
          if (sessionId && agentCaps.loadSession) {
            await sendRequest("session/load", { sessionId, cwd, mcpServers: [] });
          } else {
            const created = await sendRequest("session/new", { cwd, mcpServers: [] });
            sessionId = String(created.sessionId ?? sessionId ?? `acp-${Date.now()}`);
          }

          const turnRes = await sendRequest("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: input.prompt }],
          });
          const stopReason = String(turnRes.stopReason ?? "end_turn");
          finish({
            ok: stopReason !== "refusal" && stopReason !== "cancelled",
            roundId,
            hopCount: hop + 1,
            maxHops: DEFAULT_MAX_HOPS,
            conversationId: sessionId,
            message: chunks.join("").trim() || `ACP stopReason=${stopReason}`,
          });
        } catch (err) {
          finish({
            ok: false,
            roundId,
            hopCount: hop + 1,
            maxHops: DEFAULT_MAX_HOPS,
            ...(sessionId ? { conversationId: sessionId } : {}),
            errorCode: "AGENTAPI_FAILED",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    });
  }
}

export interface DualTrackCodingBudgetOptions {
  apiUsdDailyCap?: number;
  subscriptionMaxTurnsPerWindow?: number;
  subscriptionWindowMs?: number;
}

export class DualTrackCodingBudget {
  private readonly apiUsdCap: number;
  private readonly maxSubTurns: number;
  private readonly windowMs: number;
  private apiUsdSpent = 0;
  private readonly apiByBackend = new Map<string, number>();
  private readonly subTimestampsByBackend = new Map<string, number[]>();

  constructor(opts: DualTrackCodingBudgetOptions = {}) {
    this.apiUsdCap = Math.max(0, opts.apiUsdDailyCap ?? 20);
    this.maxSubTurns = Math.max(1, opts.subscriptionMaxTurnsPerWindow ?? 30);
    this.windowMs = Math.max(1_000, opts.subscriptionWindowMs ?? 3_600_000);
  }

  recordApiUsageUsd(backend: string, usd: number, _nowMs = Date.now()): void {
    if (!Number.isFinite(usd) || usd <= 0) return;
    this.apiUsdSpent += usd;
    this.apiByBackend.set(backend, (this.apiByBackend.get(backend) ?? 0) + usd);
  }

  canDispatchApiUsd(nowMs = Date.now()): { allowed: boolean; remainingUsd: number } {
    void nowMs;
    const rem = Math.max(0, this.apiUsdCap - this.apiUsdSpent);
    return { allowed: rem > 0, remainingUsd: rem };
  }

  private pruneWindow(backend: string, nowMs: number): number[] {
    const list = (this.subTimestampsByBackend.get(backend) ?? []).filter(
      (ts) => nowMs - ts < this.windowMs,
    );
    this.subTimestampsByBackend.set(backend, list);
    return list;
  }

  recordSubscriptionTurn(backend: string, nowMs = Date.now()): void {
    const list = this.pruneWindow(backend, nowMs);
    list.push(nowMs);
  }

  canDispatchSubscription(
    backend: string,
    nowMs = Date.now(),
  ): { allowed: boolean; usedTurns: number; maxTurns: number; retryAfterMs: number } {
    const list = this.pruneWindow(backend, nowMs);
    if (list.length < this.maxSubTurns) {
      return { allowed: true, usedTurns: list.length, maxTurns: this.maxSubTurns, retryAfterMs: 0 };
    }
    const oldest = list[0]!;
    return {
      allowed: false,
      usedTurns: list.length,
      maxTurns: this.maxSubTurns,
      retryAfterMs: Math.max(1, oldest + this.windowMs - nowMs),
    };
  }

  snapshot(nowMs = Date.now()) {
    const subUsage: Record<string, { usedTurns: number; maxTurns: number }> = {};
    for (const key of this.subTimestampsByBackend.keys()) {
      const list = this.pruneWindow(key, nowMs);
      subUsage[key] = { usedTurns: list.length, maxTurns: this.maxSubTurns };
    }
    return {
      apiUsdSpent: this.apiUsdSpent,
      apiUsdCap: this.apiUsdCap,
      apiUsdRemain: Math.max(0, this.apiUsdCap - this.apiUsdSpent),
      apiByBackend: Object.fromEntries(this.apiByBackend),
      subscriptionWindowMs: this.windowMs,
      subscriptionByBackend: subUsage,
    };
  }
}

export async function runCrossAgentCodingLoop(input: {
  workspacePath: string;
  title: string;
  coderPrompt: string;
  coderHarness: CodingHarnessPort;
  runGate: () => Promise<{ passed: boolean; summary: string }>;
  reviewerHarness: CodingHarnessPort;
  hopCount?: number;
}): Promise<{
  ok: boolean;
  coderOutcome: DispatchOutcome;
  gatePassed: boolean;
  gateSummary: string;
  reviewOutcome?: DispatchOutcome;
  reviewApproved: boolean;
}> {
  const coderOutcome = await input.coderHarness.dispatchPhasePrompt({
    workspacePath: input.workspacePath,
    title: input.title,
    prompt: input.coderPrompt,
    hopCount: input.hopCount,
  });
  if (!coderOutcome.ok) {
    return {
      ok: false,
      coderOutcome,
      gatePassed: false,
      gateSummary: "Skipped gate because coder harness failed.",
      reviewApproved: false,
    };
  }

  const gate = await input.runGate();
  if (!gate.passed) {
    return {
      ok: false,
      coderOutcome,
      gatePassed: false,
      gateSummary: gate.summary,
      reviewApproved: false,
    };
  }

  const reviewOutcome = await input.reviewerHarness.dispatchPhasePrompt({
    workspacePath: input.workspacePath,
    title: `Review: ${input.title}`,
    prompt: `请以只读代码审查身份核验本工作区变更与门禁结果（${gate.summary}），给出 Verdict: Approve 或 Request changes。`,
    hopCount: (input.hopCount ?? 0) + 1,
  });

  const detail = String(reviewOutcome.message ?? "");
  const reviewApproved =
    reviewOutcome.ok && !/request\s+changes/i.test(detail);

  return {
    ok: reviewApproved,
    coderOutcome,
    gatePassed: true,
    gateSummary: gate.summary,
    reviewOutcome,
    reviewApproved,
  };
}
