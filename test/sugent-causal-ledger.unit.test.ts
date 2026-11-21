import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findAppRoot } from "../src/magpie/supervisor.js";
import { CausalLedger } from "../src/sugent/causal-ledger.js";
import {
  DEFAULT_MAX_HOPS,
  deriveChildTriggerHop,
  evaluatePersonalTrigger,
  resetHopChainByOwner,
} from "../src/sugent/kernel.js";
import type { PersonalTrigger, ProactiveRulePolicy } from "../src/sugent/types.js";

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-causal-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** 确定性线性同余伪随机数生成器（Mulberry32），用于可复现状态机不变量模拟测试 */
function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("M2.1 TTL Hop Circuit Breaker (kernel.ts)", () => {
  const baseTrigger: PersonalTrigger = {
    id: "trig-root",
    sourceKind: "github",
    sourceInstanceId: "gh-main",
    threadKey: "github:ldc861117/sugent#10",
    senderId: "ldc861117",
    addressedToAgent: false,
    fromAllowedSender: true,
    text: "Check CI status",
    createdAt: "2026-11-11T10:00:00.000Z",
  };

  const actRule: ProactiveRulePolicy = {
    id: "rl-ci",
    title: "自动修复并复查 CI",
    sourceKind: "github",
    mode: "act",
    verifiedObservations: 5,
    suggestPromoteAfter: 3,
  };

  it("allows hops 0..8 and halts immediately at hop 9 (> DEFAULT_MAX_HOPS)", () => {
    let current: PersonalTrigger = { ...baseTrigger, hopCount: 0 };

    for (let hop = 0; hop <= DEFAULT_MAX_HOPS; hop++) {
      const dec = evaluatePersonalTrigger(current, { matchingRules: [actRule] });
      expect(dec.outcome).toBe("accept_act");
      expect(dec.hopCount).toBe(hop);
      expect(dec.maxHops).toBe(DEFAULT_MAX_HOPS);

      const nextHop = deriveChildTriggerHop(current);
      current = {
        ...current,
        id: `trig-hop-${nextHop.hopCount}`,
        hopCount: nextHop.hopCount,
        originTriggerId: nextHop.originTriggerId,
      };
    }

    // 第 9 跳（hopCount = 9 > 8）：即使发送者合法、显式点名或有活跃工单，也必须立即熔断止损
    expect(current.hopCount).toBe(9);
    expect(current.originTriggerId).toBe("trig-root");

    const haltedProactive = evaluatePersonalTrigger(current, { matchingRules: [actRule] });
    expect(haltedProactive.outcome).toBe("halt_circuit_breaker");
    expect(haltedProactive.reasonCode).toBe("hop_limit_exceeded");
    expect(haltedProactive.requiresOwnerAlert).toBe(true);
    expect(haltedProactive.recommendedRole).toBe("assessor");

    const haltedFollowup = evaluatePersonalTrigger(
      { ...current, addressedToAgent: true },
      { activeTicketIdForThread: "ticket-99" },
    );
    expect(haltedFollowup.outcome).toBe("halt_circuit_breaker");
  });

  it("only resets hopCount when explicitly invoked by owner via resetHopChainByOwner", () => {
    const deepTrigger: PersonalTrigger = {
      ...baseTrigger,
      id: "trig-9",
      hopCount: 9,
      originTriggerId: "trig-root",
    };
    expect(() => resetHopChainByOwner(deepTrigger, "   ")).toThrow();

    const reset = resetHopChainByOwner(deepTrigger, "owner:lvdongchen");
    expect(reset.hopCount).toBe(0);
    expect(reset.originTriggerId).toBe("trig-9");
    expect(reset.meta?.hopResetByOwner).toBe("owner:lvdongchen");

    const afterReset = evaluatePersonalTrigger(reset, { matchingRules: [actRule] });
    expect(afterReset.outcome).toBe("accept_act");
  });
});

describe("M2.1 Append-Only CausalLedger & explainWhy Trace", () => {
  it("persists facts with hash chaining, rebuilds after restart, and formats why trace", () => {
    const dir = makeTempDir();
    const ledger = new CausalLedger(dir);

    ledger.append({
      roundId: "1",
      kind: "round_triggered",
      at: "2026-11-11T20:47:25.000Z",
      title: "审查上游合并请求",
      ruleId: "rl-sync",
      ruleVersion: 2,
      source: "github",
      eventType: "pull_request.opened",
      targetRef: "ldc861117/sugent#12",
      hopCount: 1,
    });
    ledger.append({
      roundId: "1",
      kind: "gate_evaluated",
      at: "2026-11-11T20:47:26.000Z",
      outcome: "accept_act",
      reasonCode: "proactive_rule_act",
      hopCount: 1,
      maxHops: 8,
    });
    ledger.append({
      roundId: "1",
      kind: "worker_claimed",
      at: "2026-11-11T20:47:26.200Z",
      workerId: "bot:architect",
      modelRole: "executor",
    });
    ledger.append({
      roundId: "1",
      kind: "approval_requested",
      at: "2026-11-11T20:48:00.000Z",
      approvalId: "ap-7",
      summary: "合并到主分支前请求确认",
    });
    ledger.append({
      roundId: "1",
      kind: "approval_decided",
      at: "2026-11-11T20:49:10.000Z",
      approvalId: "ap-7",
      approved: true,
      decidedBy: "owner",
      summary: "同意合并",
    });
    ledger.append({
      roundId: "1",
      kind: "round_completed",
      at: "2026-11-11T20:49:30.000Z",
      outcome: "done",
      costUsd: 0.0325,
      summary: "已完成合并并通过回归验证",
    });

    expect(ledger.cursor).toBe(6);

    const whyText = ledger.explainWhy(1);
    expect(whyText).toContain("第 1 轮 · 审查上游合并请求");
    expect(whyText).toContain("规则版本 #2 (rl-sync)");
    expect(whyText).toContain("触发事件：来源 github · 类型 pull_request.opened · 对象 ldc861117/sugent#12 · 跳数 1");
    expect(whyText).toContain("门控判定：accept_act [proactive_rule_act]（跳数 1/8）");
    expect(whyText).toContain("bot:architect 领取（角色 executor）");
    expect(whyText).toContain("挂起拍板：#ap-7");
    expect(whyText).toContain("人工决策：owner 批准 #ap-7");
    expect(whyText).toContain("结束：已完成合并并通过回归验证（花费 $0.0325）");

    // 模拟进程重启：新建实例从磁盘 JSONL 重建全部投影，状态与哈希链完全一致
    const recovered = new CausalLedger(dir);
    expect(recovered.cursor).toBe(6);
    expect(recovered.headHash).toBe(ledger.headHash);
    const trace = recovered.traceRound("1");
    expect(trace?.status).toBe("completed");
    expect(trace?.approvals).toHaveLength(1);
    expect(trace?.approvals[0]?.approved).toBe(true);
    expect(trace?.totalCostUsd).toBe(0.0325);
    expect(recovered.streamAfter(4)).toHaveLength(2);
  });

  it("detects tampered JSONL records during rebuildProjection", () => {
    const dir = makeTempDir();
    const ledger = new CausalLedger(dir);
    ledger.append({
      roundId: "2",
      kind: "round_triggered",
      at: "2026-11-11T10:00:00.000Z",
      title: "原始标题",
    });

    const raw = fs.readFileSync(ledger.logFilePath, "utf8").replace("原始标题", "被篡改标题");
    fs.writeFileSync(ledger.logFilePath, raw, "utf8");

    expect(() => new CausalLedger(dir)).toThrow(/tampered record detected/);
  });

  it("passes 500-step deterministic seeded simulation invariants", () => {
    const runSimulation = (seed: number) => {
      const rng = createSeededRng(seed);
      const dir = makeTempDir();
      const ledger = new CausalLedger(dir);
      const decisions: string[] = [];

      for (let step = 1; step <= 500; step++) {
        const hopCount = Math.floor(rng() * 12); // 0..11
        const fromAllowed = rng() > 0.2;
        const addressed = rng() > 0.5;
        const mode = rng() > 0.5 ? ("act" as const) : ("observe" as const);

        const trigger: PersonalTrigger = {
          id: `sim-${step}`,
          sourceKind: "schedule",
          sourceInstanceId: "sim",
          threadKey: `sim:${step % 17}`,
          senderId: fromAllowed ? "owner" : "guest",
          addressedToAgent: addressed,
          fromAllowedSender: fromAllowed,
          text: `step-${step}`,
          createdAt: "2026-11-11T00:00:00.000Z",
          hopCount,
        };

        const dec = evaluatePersonalTrigger(trigger, {
          matchingRules: [
            {
              id: "r-sim",
              title: "Sim Rule",
              sourceKind: "schedule",
              mode,
              verifiedObservations: 0,
              suggestPromoteAfter: 3,
            },
          ],
        });

        // 不变量 1：任何未授权发送者绝不派活，也不误报熔断
        if (!fromAllowed) {
          expect(dec.outcome).toBe("ignore_noise");
          expect(dec.reasonCode).toBe("unlisted_sender");
        }
        // 不变量 2：任何已授权且 hopCount > 8 的触发器 100% 触发熔断，绝不进入 accept_act / attach_ticket
        if (fromAllowed && hopCount > DEFAULT_MAX_HOPS) {
          expect(dec.outcome).toBe("halt_circuit_breaker");
          expect(dec.requiresOwnerAlert).toBe(true);
        }

        if (step <= 60) {
          ledger.append({
            roundId: String(step),
            kind: dec.outcome === "halt_circuit_breaker" ? "circuit_broken" : "gate_evaluated",
            at: "2026-11-11T00:00:00.000Z",
            outcome: dec.outcome,
            reasonCode: dec.reasonCode,
            hopCount: dec.hopCount,
            maxHops: dec.maxHops,
          });
        }
        decisions.push(`${dec.outcome}:${dec.reasonCode}:${dec.hopCount}`);
      }

      const reloaded = new CausalLedger(dir);
      expect(reloaded.cursor).toBe(60);
      return { decisions, headHash: reloaded.headHash };
    };

    // 同一随机种子跑两遍，500 步决策序列与账本链顶哈希必须 100% 完全相同（确定性保证）
    const firstRun = runSimulation(24301);
    const secondRun = runSimulation(24301);
    expect(secondRun.decisions).toEqual(firstRun.decisions);
    expect(secondRun.headHash).toBe(firstRun.headHash);
  });
});

describe("M2.1 Kernel Architecture Purity Gate", () => {
  it("enforces zero network/fs/clock/random I/O and zero vendor hardcoding in src/sugent/kernel.ts", () => {
    const kernelFile = path.join(findAppRoot(), "src", "sugent", "kernel.ts");
    const source = fs.readFileSync(kernelFile, "utf8");
    // 剥离块注释与单行注释后检查可执行源码
    const codeOnly = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    const forbiddenApis = [
      /\bfetch\s*\(/,
      /\bnode:(?:fs|http|https|net|tls|child_process|dgram|dns)\b/,
      /\bDate\.now\s*\(/,
      /\bnew\s+Date\s*\(/,
      /\bMath\.random\s*\(/,
      /\bcrypto\.random/,
      /\bsetTimeout\s*\(/,
      /\bsetInterval\s*\(/,
    ];
    for (const pattern of forbiddenApis) {
      expect(codeOnly, `Forbidden non-deterministic or I/O API ${pattern} in kernel.ts`).not.toMatch(
        pattern,
      );
    }

    const forbiddenVendorLiterals = [
      /\bclaude\b/i,
      /\bcodex\b/i,
      /\bopenai\b/i,
      /\banthropic\b/i,
      /\bdeepseek-chat\b/i,
      /\bmodelflare\b/i,
      /\bfeishu\b/i,
      /\bweixin\b/i,
      /\btelegram\b/i,
      /\bdiscord\b/i,
    ];
    for (const vendor of forbiddenVendorLiterals) {
      expect(codeOnly, `Forbidden hardcoded vendor/product name ${vendor} in kernel.ts`).not.toMatch(
        vendor,
      );
    }
  });
});
