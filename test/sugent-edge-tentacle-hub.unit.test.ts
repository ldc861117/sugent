import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EdgeTentacleHub,
  EdgeTentacleRunner,
  parseRepoRoadmapMarkdown,
  parseRepoStatusMarkdown,
  redactLocalPaths,
  scanLocalProjectsForEdge,
} from "../src/sugent/edge-tentacle-hub.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Sugent Edge-Tentacle Hub & Local Governance Scanner", () => {
  it("parses STATUS.md frontmatter + 5 Chinese governance sections and normalizes placeholder blockers", () => {
    const md = [
      "---",
      "status_version: 1",
      "project: airtoken",
      "review_state: pending_review",
      "updated_by: gemini@local-mac",
      'updated_at: "2026-11-25T10:00:00Z"',
      "---",
      "",
      "## 阶段目标",
      "",
      "打通 AirToken 与 Kev 决策闭环",
      "",
      "## 最近完成",
      "- 完成计费结算核心单测",
      "- 修复配额漂移告警",
      "",
      "## 在途",
      "- 联调 GCE 节点同步",
      "",
      "## 下一步",
      "1. 压测高并发扣费",
      "",
      "## 卡点",
      "- 暂无阻塞卡点。",
    ].join("\n");

    const parsed = parseRepoStatusMarkdown(md);
    expect(parsed.reviewState).toBe("pending_review");
    expect(parsed.updatedBy).toBe("gemini@local-mac");
    expect(parsed.updatedAt).toBe("2026-11-25T10:00:00Z");
    expect(parsed.stageGoal).toBe("打通 AirToken 与 Kev 决策闭环");
    expect(parsed.landed).toEqual(["完成计费结算核心单测", "修复配额漂移告警"]);
    expect(parsed.inflight).toEqual([{ text: "联调 GCE 节点同步" }]);
    expect(parsed.nextActions).toEqual(["压测高并发扣费"]);
    expect(parsed.blockers).toEqual([]);
  });

  it("parses ROADMAP.md checkboxes and identifies the first active incomplete section", () => {
    const roadmap = [
      "# AirToken Roadmap",
      "## Wave P0: 核心底座",
      "- [x] P0.1 账本初始化",
      "- [x] P0.2 鉴权网关",
      "## Wave P1: 商业闭环",
      "- [x] P1.1 额度结算",
      "- [ ] P1.2 渠道分成对账",
      "## Wave P2: 规模化",
      "- [ ] P2.1 多租户看板",
    ].join("\n");

    const parsed = parseRepoRoadmapMarkdown(roadmap);
    expect(parsed.totals).toEqual({ done: 3, total: 5, pct: 60 });
    expect(parsed.activeNode?.code).toBe("Wave P1");
    expect(parsed.activeNode?.title).toBe("商业闭环");
    expect(parsed.activeNode?.progress).toEqual({ done: 1, total: 2, pct: 50 });
  });

  it("scans local projects, derives canonical projectKey, redacts local paths, and enforces Tier 0/1/2 privacy pruning", () => {
    const root = makeTempDir("sugent-edge-scan-");
    const airtokenDir = path.join(root, "airtoken");
    fs.mkdirSync(path.join(airtokenDir, ".git"), { recursive: true });
    fs.mkdirSync(path.join(airtokenDir, "docs"), { recursive: true });
    fs.writeFileSync(
      path.join(airtokenDir, ".git", "config"),
      '[remote "origin"]\n\turl = git@github.com:Ldc861117/AirToken.git\n',
    );
    fs.writeFileSync(
      path.join(airtokenDir, "STATUS.md"),
      [
        "---",
        "review_state: confirmed",
        "updated_at: 2026-11-25T12:00:00Z",
        "---",
        "## 阶段目标",
        "推进 /Users/lvdongchen/Projects/airtoken 商业化上线",
        "## 最近完成",
        "- 已生成 /Users/lvdongchen/secret/report.md 审计报告",
        "## 在途",
        "- 正在执行联调",
        "## 下一步",
        "- 发布 v1.0",
        "## 卡点",
        "无",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(airtokenDir, "docs", "ROADMAP.md"),
      "## M1 核心交付\n- [x] 子项一\n- [ ] 子项二\n",
    );

    const secretDir = path.join(root, "private-vault");
    fs.mkdirSync(secretDir, { recursive: true });
    fs.writeFileSync(path.join(secretDir, "package.json"), '{"name":"private-vault"}');
    fs.writeFileSync(path.join(secretDir, "STATUS.md"), "## 阶段目标\n绝密内部账本\n");

    const summaryDir = path.join(root, "summary-only");
    fs.mkdirSync(summaryDir, { recursive: true });
    fs.writeFileSync(path.join(summaryDir, "package.json"), '{"name":"summary-only"}');
    fs.writeFileSync(path.join(summaryDir, "STATUS.md"), "## 阶段目标\n仅同步阶段目标\n## 在途\n- 敏感内部会话细节\n");

    const pulses = scanLocalProjectsForEdge({
      projectsRootDirs: [root],
      nodeId: "local-mac",
      nowIso: "2026-11-25T12:05:00Z",
      resolveTier: (projectKey) => {
        if (projectKey.includes("private-vault")) return 0;
        if (projectKey.includes("summary-only")) return 1;
        return 2;
      },
      sessions: [
        {
          projectKey: "repo:ldc861117/airtoken",
          conversationId: "conv-air-1",
          title: "调试 /Users/lvdongchen/Projects/airtoken 路由",
          isRunning: true,
          stepCount: 12,
          activeSubagentCount: 2,
        },
      ],
    });

    expect(pulses).toHaveLength(3);
    const serialized = JSON.stringify(pulses);
    expect(serialized).not.toContain("/Users/lvdongchen");
    expect(redactLocalPaths("路径 /home/ubuntu/work/secret.txt 已脱敏")).toContain("[local-path]");

    const tier2 = pulses.find((p) => p.projectKey === "repo:ldc861117/airtoken");
    expect(tier2).toBeDefined();
    expect(tier2?.displayName).toBe("airtoken");
    expect(tier2?.statusCard?.stageGoal).toContain("[local-path]");
    expect(tier2?.roadmapSummary?.totals).toEqual({ done: 1, total: 2, pct: 50 });
    expect(tier2?.runningSessions?.[0]?.title).toContain("[local-path]");

    const tier0 = pulses.find((p) => p.tier === 0);
    expect(tier0?.projectKey.startsWith("tier0:")).toBe(true);
    expect(tier0?.displayName).toBeUndefined();
    expect(tier0?.statusCard).toBeUndefined();
    expect(tier0?.sanitizedSummary).toBeUndefined();

    const tier1 = pulses.find((p) => p.tier === 1);
    expect(tier1?.displayName).toBe("summary-only");
    expect(tier1?.statusCard?.stageGoal).toBe("仅同步阶段目标");
    expect(tier1?.statusCard?.inflight).toBeUndefined();
    expect(tier1?.runningSessions).toBeUndefined();
  });

  it("persists EdgeTentacleHub atomically (0o600), verifies tokens in constant time, merges multi-node pulses, and generates idempotent WeChat acks", () => {
    const dataDir = makeTempDir("sugent-edge-hub-");
    let nowMs = Date.parse("2026-11-25T12:00:00Z");
    const hub = new EdgeTentacleHub({
      dataDir,
      edgeTokens: ["edge-secret-token-2026"],
      now: () => nowMs,
    });

    expect(hub.verifyToken("edge-secret-token-2026")).toBe(true);
    expect(hub.verifyToken("wrong-short")).toBe(false);
    expect(hub.verifyToken("")).toBe(false);
    expect(hub.verifyToken(undefined)).toBe(false);

    hub.ingestNodePulse({
      nodeId: "local-mac",
      platform: "darwin",
      atIso: "2026-11-25T11:58:00Z",
      projects: [
        {
          projectKey: "repo:ldc861117/airtoken",
          displayName: "airtoken",
          tier: 2,
          status: "idle",
          updatedAtIso: "2026-11-25T11:58:00Z",
          statusCard: { stageGoal: "旧阶段目标", updatedAt: "2026-11-25T11:00:00Z" },
        },
      ],
    });

    const ingest2 = hub.ingestNodePulse({
      nodeId: "gce-remote",
      platform: "linux",
      atIso: "2026-11-25T12:00:00Z",
      projects: [
        {
          projectKey: "repo:ldc861117/airtoken",
          displayName: "airtoken",
          tier: 2,
          status: "running",
          updatedAtIso: "2026-11-25T12:00:00Z",
          statusCard: { stageGoal: "云端最新阶段目标", updatedAt: "2026-11-25T11:59:00Z" },
        },
      ],
    });

    const stateFile = path.join(dataDir, "sugent-stewardship", "edge-fleet-state.json");
    expect(fs.existsSync(stateFile)).toBe(true);
    expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);

    const mergedProj = ingest2.snapshot.projects.find((p) => p.projectKey === "repo:ldc861117/airtoken");
    expect(mergedProj?.nodes).toEqual(expect.arrayContaining(["local-mac", "gce-remote"]));
    expect(mergedProj?.statusCard?.stageGoal).toBe("云端最新阶段目标");
    expect(mergedProj?.status).toBe("running");

    const cmd = hub.enqueueCommand({
      targetNodeId: "local-mac",
      action: "dispatch_antigravity_new",
      title: "为 airtoken 补充对账导出测试",
      prompt: "请补充 airtoken 对账单导出回归测试",
      projectKey: "repo:ldc861117/airtoken",
    });

    const firstPull = hub.pullPendingCommands("local-mac", new Date(nowMs).toISOString());
    expect(firstPull.map((c) => c.id)).toEqual([cmd.id]);
    // Within 120s lease window, duplicate poll does not re-issue leased command
    nowMs += 30_000;
    expect(hub.pullPendingCommands("local-mac", new Date(nowMs).toISOString())).toHaveLength(0);
    // After 120s lease expiry without ack, command becomes pullable again
    nowMs += 100_000;
    expect(hub.pullPendingCommands("local-mac", new Date(nowMs).toISOString()).map((c) => c.id)).toEqual([cmd.id]);

    const ack1 = hub.ackCommand(cmd.id, {
      nodeId: "local-mac",
      status: "completed",
      summary: "已拉起新会话 conv-999",
      conversationId: "conv-999",
    });
    expect(ack1.ok).toBe(true);
    expect(ack1.idempotent).toBeFalsy();
    expect(ack1.ownerNotifyText).toContain("local-mac");
    expect(ack1.ownerNotifyText).toContain("为 airtoken 补充对账导出测试");

    const ack2 = hub.ackCommand(cmd.id, {
      nodeId: "local-mac",
      status: "completed",
      summary: "已拉起新会话 conv-999",
      conversationId: "conv-999",
    });
    expect(ack2.ok).toBe(true);
    expect(ack2.idempotent).toBe(true);
    expect(ack2.ownerNotifyText).toBeUndefined();
  });

  it("executes EdgeTentacleRunner end-to-end against EdgeTentacleHub", async () => {
    const root = makeTempDir("sugent-edge-runner-proj-");
    const dataDir = makeTempDir("sugent-edge-runner-hub-");
    const repoDir = path.join(root, "sugent");
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, "STATUS.md"), "## 阶段目标\n云端唯一大脑联调\n");

    const hub = new EdgeTentacleHub({ dataDir, edgeTokens: ["tok-edge-runner"] });
    const cmd = hub.enqueueCommand({
      targetNodeId: "local-mac",
      action: "dispatch_antigravity_new",
      title: "验证远程唤醒",
      prompt: "运行自检",
      projectKey: "local:local-mac:sugent",
    });

    const dispatched: string[] = [];
    const runner = new EdgeTentacleRunner({
      hubUrl: "https://sugent.metamirror.club",
      edgeToken: "tok-edge-runner",
      nodeId: "local-mac",
      projectsRootDirs: [root],
      dispatchAntigravity: async (queued) => {
        dispatched.push(queued.id);
        return { ok: true, summary: "Antigravity 已启动", conversationId: "conv-edge-1" };
      },
      fetchImpl: async (input, init) => {
        const u = new URL(String(input));
        const auth = new Headers(init?.headers).get("authorization") ?? "";
        const tok = auth.replace(/^Bearer\s+/i, "");
        if (!hub.verifyToken(tok)) return new Response("unauthorized", { status: 401 });
        if (u.pathname === "/amb/api/steward/edge/pulse" && init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          return new Response(JSON.stringify(hub.ingestNodePulse(body)), { status: 200 });
        }
        if (u.pathname === "/amb/api/steward/edge/commands" && (!init?.method || init.method === "GET")) {
          const nodeId = u.searchParams.get("nodeId") || "";
          return new Response(JSON.stringify({ ok: true, commands: hub.pullPendingCommands(nodeId) }), { status: 200 });
        }
        const ackMatch = /^\/amb\/api\/steward\/edge\/commands\/([^/]+)\/ack$/.exec(u.pathname);
        if (ackMatch && init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          return new Response(JSON.stringify(hub.ackCommand(decodeURIComponent(ackMatch[1]!), body)), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const cycle = await runner.runCycleOnce();
    expect(cycle.pulseOk).toBe(true);
    expect(cycle.projectCount).toBe(1);
    expect(cycle.commandsExecuted).toBe(1);
    expect(cycle.errors).toEqual([]);
    expect(dispatched).toEqual([cmd.id]);
    expect(hub.toOpsStewardSnapshot().projects[0]?.displayName).toBe("sugent");
  });
});
