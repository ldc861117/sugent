import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runSugentTryWalkthrough } from "../src/cli/try.js";
import { parseWhyCliArgs, runWhyCli } from "../src/cli/why.js";
import {
  SuspendedRoundStore,
  TriggerCoalescer,
  ZeroTokenProbeTracker,
  materializeReceiptFollowups,
  parseAgentReceipt,
} from "../src/sugent/index.js";
import type { PersonalTrigger } from "../src/sugent/types.js";

describe("M2.1 Receipt Protocol & Zero-Cost Suspension", () => {
  it("parses structured sugent-receipt blocks and builds localized repair prompts on malformed JSON", () => {
    const valid = parseAgentReceipt(
      [
        "巡检完成，站点已恢复正常。",
        "```sugent-receipt",
        JSON.stringify({
          status: "completed",
          summary: "站点恢复 200 OK，自动关闭告警卡片并预约复查",
          later: { delaySec: 600, reason: "10 分钟后复核站点稳定性" },
          resolve: { cardId: "card-alert-9", resolution: "上游证书已续期，HTTP 200 恢复" },
          events: [{ threadKey: "ops:deploy-log", summary: "记录自动恢复归档" }],
        }),
        "```",
      ].join("\n"),
    );

    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.receipt.status).toBe("completed");
      expect(valid.receipt.later?.delaySec).toBe(600);
      expect(valid.receipt.resolve?.cardId).toBe("card-alert-9");
      expect(valid.receipt.events).toHaveLength(1);
    }

    const broken = parseAgentReceipt("已完成修改\n```sugent-receipt\n{broken_json\n```");
    expect(broken.ok).toBe(false);
    if (!broken.ok) {
      expect(broken.repairPrompt).toContain("请勿重新执行任何工具调用");
      expect(broken.repairPrompt).toContain("sugent-receipt");
    }
  });

  it("increments hopCount across later wakeups and downstream events without resetting", () => {
    const parent: PersonalTrigger = {
      id: "tr-parent",
      sourceKind: "github",
      sourceInstanceId: "gh-1",
      threadKey: "github:ldc861117/sugent#5",
      senderId: "owner",
      addressedToAgent: true,
      fromAllowedSender: true,
      text: "check deploy",
      createdAt: "2026-11-12T10:00:00.000Z",
      hopCount: 3,
      originTriggerId: "tr-origin-0",
    };

    const parsed = parseAgentReceipt(
      '```sugent-receipt\n{"status":"completed","summary":"ok","later":{"delaySec":300,"reason":"recheck"},"events":[{"threadKey":"im:notify","summary":"ping"}]}\n```',
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const out = materializeReceiptFollowups(parent, parsed.receipt, "2026-11-12T10:01:00.000Z");
    expect(out.scheduledWakeup?.trigger.hopCount).toBe(4);
    expect(out.scheduledWakeup?.trigger.originTriggerId).toBe("tr-origin-0");
    expect(out.scheduledWakeup?.wakeAtIso).toBe("2026-11-12T10:06:00.000Z");
    expect(out.downstreamTriggers[0]?.hopCount).toBe(4);
    expect(out.downstreamTriggers[0]?.originTriggerId).toBe("tr-origin-0");
  });

  it("persists zero-cost suspended checkpoints, preserves hopCount, and blocks duplicate resume replay", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-suspend-"));
    try {
      const store = new SuspendedRoundStore(tmpDir);
      const trigger: PersonalTrigger = {
        id: "tr-7",
        sourceKind: "im_channel",
        sourceInstanceId: "wx-1",
        threadKey: "wx:owner",
        senderId: "owner",
        addressedToAgent: true,
        fromAllowedSender: true,
        text: "deploy prod",
        createdAt: "2026-11-12T10:00:00.000Z",
        hopCount: 5,
        originTriggerId: "tr-root-1",
      };

      const saved = store.suspend({
        roundId: "rnd-55",
        sessionId: "dsh-sess-55",
        parentTrigger: trigger,
        approval: { approvalId: "ap-prod", prompt: "确认发布生产环境？", riskLevel: "high" },
        suspendedAt: "2026-11-12T10:00:10.000Z",
      });
      expect(saved.hopCount).toBe(5);
      expect(store.listPending()).toHaveLength(1);

      const resumed = store.resume("rnd-55", {
        approved: true,
        decidedBy: "owner",
        note: "批准上线",
        resumedAt: "2026-11-12T12:30:00.000Z",
      });
      expect(resumed.checkpoint.status).toBe("resumed");
      expect(resumed.checkpoint.hopCount).toBe(5);
      expect(resumed.resumePrompt).toContain("已批准 (APPROVED)");
      expect(store.listPending()).toHaveLength(0);

      // 连点第二次卡片必须幂等拦截，防止写操作执行两遍
      expect(() =>
        store.resume("rnd-55", {
          approved: true,
          decidedBy: "owner",
          resumedAt: "2026-11-12T12:30:02.000Z",
        }),
      ).toThrowError(/already resumed/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("M2.2 Zero-Token Pre-Check Probes & ThreadKey Coalescing", () => {
  it("short-circuits unchanged/healthy probes at 0 token cost and emits recovery with original cardId", () => {
    const tracker = new ZeroTokenProbeTracker();

    // 正常状态：0 Token 跳过
    const r1 = tracker.evaluate({
      probeId: "site-health",
      healthy: true,
      output: "HTTP 200 v1.2.0",
      at: "2026-11-12T10:00:00.000Z",
    });
    expect(r1.shouldWakeAgent).toBe(false);
    expect(r1.reason).toBe("healthy_unchanged");

    // 首次异常：唤醒 Agent 发告警卡片
    const r2 = tracker.evaluate({
      probeId: "site-health",
      healthy: false,
      output: "HTTP 502 Bad Gateway",
      alertCardId: "card-502-1",
      at: "2026-11-12T10:05:00.000Z",
    });
    expect(r2.shouldWakeAgent).toBe(true);
    expect(r2.reason).toBe("first_failure");
    expect(r2.alertCardId).toBe("card-502-1");

    // 持续同一异常：静默抑制，避免每 5 分钟轰炸和浪费 Token
    const r3 = tracker.evaluate({
      probeId: "site-health",
      healthy: false,
      output: "HTTP 502 Bad Gateway",
      at: "2026-11-12T10:10:00.000Z",
    });
    expect(r3.shouldWakeAgent).toBe(false);
    expect(r3.reason).toBe("ongoing_failure_suppressed");

    // 故障恢复：唤醒一次并附带原告警卡片 ID 供 resolve 更新关闭
    const r4 = tracker.evaluate({
      probeId: "site-health",
      healthy: true,
      output: "HTTP 200 v1.2.0",
      at: "2026-11-12T10:15:00.000Z",
    });
    expect(r4.shouldWakeAgent).toBe(true);
    expect(r4.recovered).toBe(true);
    expect(r4.alertCardId).toBe("card-502-1");
  });

  it("coalesces burst triggers on the same threadKey while preserving highest hopCount", () => {
    const coalescer = new TriggerCoalescer();
    const mkTrigger = (id: string, text: string, hopCount: number): PersonalTrigger => ({
      id,
      sourceKind: "github",
      sourceInstanceId: "gh-1",
      threadKey: "github:ldc861117/sugent#88",
      senderId: "owner",
      addressedToAgent: id === "t2",
      fromAllowedSender: true,
      text,
      createdAt: `2026-11-12T10:00:0${hopCount}.000Z`,
      hopCount,
      originTriggerId: "orig-88",
    });

    // 标记该线程正在执行第 1 轮，后续短时间内涌入 3 条消息
    coalescer.markRunning("github:ldc861117/sugent#88");
    expect(coalescer.submit(mkTrigger("t1", "first comment", 2)).status).toBe("queued");
    expect(coalescer.submit(mkTrigger("t2", "@sugent please fix lint too", 6)).status).toBe("queued");
    expect(coalescer.submit(mkTrigger("t3", "also update docs", 4)).status).toBe("queued");

    const merged = coalescer.completeAndDrain("github:ldc861117/sugent#88");
    expect(merged).toBeDefined();
    expect(merged!.addressedToAgent).toBe(true);
    // 绝不允许通过合并洗白跳数，必须保留最大跳数 6
    expect(merged!.hopCount).toBe(6);
    expect(merged!.meta?.coalescedCount).toBe(3);
    expect(merged!.meta?.coalescedTriggerIds).toEqual(["t1", "t2", "t3"]);
    expect(merged!.text).toContain("first comment");
    expect(merged!.text).toContain("also update docs");
  });
});

describe("M1.6 sugent:try & sugent:why CLI End-to-End", () => {
  it("runs zero-token walkthrough and inspects round timeline via why CLI", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-cli-e2e-"));
    try {
      const walk = runSugentTryWalkthrough({ targetDir: tmpDir });
      expect(fs.existsSync(walk.contextFile)).toBe(true);
      expect(fs.existsSync(walk.starterRulePath)).toBe(true);
      expect(walk.whyTimeline).toContain("双上游安全补丁验证与合并体验");
      expect(walk.whyTimeline).toContain("人工决策：owner 批准 #ap-merge-101");

      const listRes = runWhyCli(parseWhyCliArgs(["--ledger-dir", walk.ledgerDir, "--list"]));
      expect(listRes.exitCode).toBe(0);
      expect(listRes.output).toContain(walk.roundId);

      const detailRes = runWhyCli(parseWhyCliArgs(["--ledger-dir", walk.ledgerDir, walk.roundId]));
      expect(detailRes.exitCode).toBe(0);
      expect(detailRes.output).toContain("触发事件：来源 github");

      const missingRes = runWhyCli(parseWhyCliArgs(["--ledger-dir", walk.ledgerDir, "non-existent"]));
      expect(missingRes.exitCode).toBe(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
