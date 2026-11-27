import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseRepoRoadmapMarkdown } from "../src/sugent/edge-tentacle-hub.js";
import { SugentKnowledgeGraph } from "../src/sugent/knowledge-graph.js";
import { LocalBudgetLedger } from "../src/sugent/local-budget.js";
import { OwnerChannelStewardRouter } from "../src/sugent/owner-channel-steward-router.js";
import { StewardLlmAgent } from "../src/sugent/steward-llm-agent.js";
import { SugentStewardHostService } from "../src/sugent/steward-host-service.js";

describe("Hybrid project planning & /ops commitment bridge", () => {
  it("syncs humanCommitments with snooze, wakes on due date into morning drain, and closes via /done", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-hybrid-commit-"));
    let nowIso = "2026-11-26T22:00:00+08:00";
    try {
      const kg = new SugentKnowledgeGraph(path.join(dir, "kg"));
      const budgets = new LocalBudgetLedger(dir);
      const host = new SugentStewardHostService({
        dataDir: dir,
        knowledgeGraph: kg,
        localBudgets: budgets,
        homeDir: dir,
        nowIso: () => nowIso,
      });

      host.setRemoteOpsSnapshot({
        projects: [],
        pendingInbox: [],
        humanCommitments: [
          {
            id: "todo:repo:ldc/sugent:a1b2c3d4",
            projectKey: "repo:ldc/sugent",
            projectName: "sugent",
            title: "提交推送 Wave P3 代码并升级云端主脑",
            stage: "needs_you",
            actor: "human",
            direction: "i_owe",
            roadmapItemId: "P3.5",
            nextAiHint: "上线后跑通首个项目群试运行",
            updatedAt: "2026-11-26T22:00:00+08:00",
          },
          {
            id: "todo:repo:ldc/sugent:e5f60708",
            projectKey: "repo:ldc/sugent",
            projectName: "sugent",
            title: "养号期满后 GCE 扫码绑号",
            stage: "running",
            actor: "human",
            direction: "i_owe",
            snoozeUntil: "2026-12-02",
            dueAt: "2026-12-02",
            roadmapItemId: "P3.6",
            updatedAt: "2026-11-26T22:00:00+08:00",
          },
        ],
      });

      const snap1 = host.ledger.snapshotForCaller("owner_private");
      expect(snap1.commitments.find((c) => c.id === "todo:repo:ldc/sugent:a1b2c3d4")?.status).toBe("open");
      expect(snap1.commitments.find((c) => c.id === "todo:repo:ldc/sugent:e5f60708")?.status).toBe("snoozed");

      nowIso = "2026-12-02T08:30:00+08:00";
      const pulse = host.runScheduledPulse({ nowMs: Date.parse(nowIso), forceMorningDrain: true });
      expect(pulse.unsnoozedWakeups?.some((w) => w.id === "todo:repo:ldc/sugent:e5f60708")).toBe(true);
      expect(pulse.morningDrain?.emitNow.some((c) => c.targetRefId === "todo:repo:ldc/sugent:e5f60708")).toBe(true);

      const router = new OwnerChannelStewardRouter({
        steward: {
          converse: async () => ({ ok: true, reply: "unused" }),
          completeCommitmentByRef: (ref) => host.completeCommitmentByRef(ref),
        },
      });
      const routeRes = await router.tryHandleInbound({
        channel: "weixin",
        peerId: "owner_wx",
        isGroup: false,
        isOwnerPeer: true,
        text: "/done P3.5",
      });
      expect(routeRes.handled).toBe(true);
      expect(routeRes.reply).toContain("已销账");
      expect(routeRes.reply).toContain("P3.5");
      expect(routeRes.reply).toContain("上线后跑通首个项目群试运行");
      expect(host.drainPendingOpsCommitmentUpdates().some((u) => u.id === "todo:repo:ldc/sugent:a1b2c3d4" && u.status === "closed")).toBe(true);

      // Natural language complete_todo tool closes snoozed P3.6 early & enqueues sync update
      const llmAgent = new StewardLlmAgent({
        toolsPort: host as unknown as ConstructorParameters<typeof StewardLlmAgent>[0]["toolsPort"],
        getEndpoint: () => ({ baseUrl: "http://127.0.0.1:0", apiKey: "test", model: "test" }),
      });
      const toolOut = await (llmAgent as unknown as {
        executeTool: (name: string, args: Record<string, unknown>, domain: string, channel: string) => Promise<Record<string, unknown>>;
      }).executeTool("complete_todo", { todoQuery: "P3.6" }, "owner_private", "weixin");
      expect(toolOut.ok).toBe(true);
      expect(toolOut.roadmapItemId).toBe("P3.6");
      expect(host.drainPendingOpsCommitmentUpdates().some((u) => u.id === "todo:repo:ldc/sugent:e5f60708" && u.status === "closed")).toBe(true);

      // TS roadmap parser parses real Wave P3 ROADMAP.md into monitoring with dual-track counts
      const realRoadmap = fs.readFileSync(path.resolve(process.cwd(), "docs/ROADMAP.md"), "utf8");
      const parsed = parseRepoRoadmapMarkdown(realRoadmap);
      expect(parsed.activeNode?.status).toBe("monitoring");
      expect(parsed.activeNode?.progress.codeDone).toBe(4);
      expect(parsed.activeNode?.progress.realDone).toBe(1);
      expect(parsed.activeNode?.progress.realTotal).toBe(3);
      expect(parsed.activeNode?.progress.pct).toBeLessThan(100);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
