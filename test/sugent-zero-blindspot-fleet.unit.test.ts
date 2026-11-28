import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AgentManager } from "../src/agent/manager.js";
import { Store } from "../src/store/db.js";
import {
  EdgeTentacleHub,
  LocalBudgetLedger,
  SugentKnowledgeGraph,
  SugentStewardHostService,
  parseRepoRoadmapMarkdown,
  parseRepoTasksMarkdown,
  readSanitizedGovernanceDocFromRepo,
  scanLocalProjectsForEdge,
} from "../src/sugent/index.js";

const tmpDirs: string[] = [];
function makeTmp(prefix = "sugent-zbs-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Zero-Blindspot Fleet Context, Dual-Source Recency Merge & DSH Bridge", () => {
  it("parses multi-phase ROADMAP.md into full nodes[].items[] and extracts recentPlans in edge scan", () => {
    const root = makeTmp();
    const repo = path.join(root, "Projects", "self-a-web");
    fs.mkdirSync(path.join(repo, "docs", "plans"), { recursive: true });
    fs.writeFileSync(path.join(repo, "docs", "plans", "2026-11-28-p3-topic-sparks.md"), "# 2026-11-28 Topic Sparks Plan\n");
    const roadmapMd = [
      "# Andy-web 演进路线图",
      "### Phase 1（当前阶段）：门面立魂",
      "- [x] **P1.1 全站导航统一**",
      "- [x] **P1.4 [我] 履历数字溯源**",
      "### Phase 2：破局室",
      "- [x] **P2.1 确定性内核**",
      "### Phase 3：机芯与管线",
      "- [x] **P3.1 首屏真·3D机芯**",
      "- [ ] **P3.2 活水选题管线**",
      "- [ ] **P3.4 [我] 首轮周度复盘**",
      "### Phase 4：商业复利",
      "- [ ] **P4.1 英文层**",
    ].join("\n");
    fs.writeFileSync(path.join(repo, "ROADMAP.md"), roadmapMd);
    fs.writeFileSync(path.join(repo, "STATUS.md"), "---\nreview_state: pending_review\n---\n## 阶段目标\n推进 P3.2\n");

    const parsed = parseRepoRoadmapMarkdown(roadmapMd);
    expect(parsed.nodes?.length).toBe(4);
    const p3 = parsed.nodes?.find((n) => n.id === "P3");
    expect(p3?.items?.map((i) => `${i.id}:${i.status}:${i.actor}`)).toEqual([
      "P3.1:done:agent",
      "P3.2:todo:agent",
      "P3.4:todo:human",
    ]);

    const scanned = scanLocalProjectsForEdge({
      projectsRootDirs: [path.join(root, "Projects")],
      homeDir: root,
      nodeId: "local-mac",
      defaultTier: 2,
    });
    expect(scanned[0]?.roadmapSummary?.nodes?.length).toBe(4);
    expect(scanned[0]?.recentPlans?.[0]?.path).toBe("docs/plans/2026-11-28-p3-topic-sparks.md");
  });

  it("merges stale offline edge pulse with newer /ops snapshot, clears zombie running state & persists cache", () => {
    const dir = makeTmp();
    const kg = new SugentKnowledgeGraph(dir);
    const budgets = new LocalBudgetLedger(dir);
    let nowIso = "2026-11-28T15:26:00+08:00";
    const svc = new SugentStewardHostService({
      dataDir: dir,
      homeDir: dir,
      knowledgeGraph: kg,
      localBudgets: budgets,
      nowIso: () => nowIso,
    });
    svc.ingestEdgeNodePulse({
      nodeId: "local-mac",
      atIso: "2026-11-28T15:26:00+08:00",
      projects: [{
        projectKey: "repo:ldc861117/self-a-web",
        displayName: "Andy-web",
        tier: 2,
        status: "running",
        boardStatus: "active_executing",
        statusCard: { stageGoal: "旧目标", reviewState: "pending_review", updatedAt: "2026-11-28T15:26:00+08:00" },
        roadmapSummary: {
          nodes: [{ id: "P3", title: "Phase 3", status: "active", items: [{ id: "P3.1", title: "3D机芯", status: "done", actor: "agent" }, { id: "P3.2", title: "活水管线", status: "todo", actor: "agent" }] }],
          totals: { done: 1, total: 2, pct: 50 },
        },
        recentPlans: [{ path: "docs/plans/2026-11-28-a.md", title: "Plan A" }],
      }],
    });
    svc.setRemoteOpsSnapshot({
      fetchedAtIso: "2026-11-28T18:00:00+08:00",
      pendingInbox: [],
      projects: [{
        projectKey: "repo:ldc861117/self-a-web",
        displayName: "self-a-web",
        tier: 2,
        status: "idle",
        boardStatus: "pending_review",
        statusCard: { stageGoal: "已完成 P3.1 并提交", reviewState: "confirmed", updatedAt: "2026-11-28T18:00:00+08:00" },
      }],
    });
    nowIso = "2026-11-28T18:25:00+08:00";
    const merged = svc.getMergedOpsFleetSnapshot();
    const p = merged?.projects.find((x) => x.projectKey === "repo:ldc861117/self-a-web");
    expect(p?.status).toBe("idle");
    expect(p?.statusCard?.stageGoal).toBe("已完成 P3.1 并提交");
    expect(p?.roadmapSummary?.nodes?.[0]?.items?.length).toBe(2);
    expect(p?.recentPlans?.[0]?.title).toBe("Plan A");

    const svcReloaded = new SugentStewardHostService({
      dataDir: dir,
      homeDir: dir,
      knowledgeGraph: kg,
      localBudgets: budgets,
      nowIso: () => nowIso,
    });
    expect(svcReloaded.getMergedOpsFleetSnapshot()?.projects.length).toBeGreaterThanOrEqual(1);
  });

  it("blocks unsafe paths, reads sanitized ROADMAP via live edge command silently & falls back offline", async () => {
    const dir = makeTmp();
    const repo = path.join(dir, "proj");
    fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".env"), "SECRET=123\n");
    fs.writeFileSync(path.join(repo, "ROADMAP.md"), "# Roadmap\nBearer sk-abcdefghijklmnopqrstuvwxyz123456\n- [x] P3.1\n- [ ] P3.2\n");
    expect(readSanitizedGovernanceDocFromRepo(repo, ".env").ok).toBe(false);
    expect(readSanitizedGovernanceDocFromRepo(repo, "../secret.md").ok).toBe(false);
    expect(readSanitizedGovernanceDocFromRepo(repo, "08_career/cv.md").ok).toBe(false);
    const roadRes = readSanitizedGovernanceDocFromRepo(repo, "docs/ROADMAP.md");
    expect(roadRes.ok).toBe(true);
    expect(roadRes.docPath).toBe("ROADMAP.md");
    expect(roadRes.content).toContain("[REDACTED]");

    const kg = new SugentKnowledgeGraph(dir);
    const budgets = new LocalBudgetLedger(dir);
    const svc = new SugentStewardHostService({ dataDir: dir, homeDir: dir, knowledgeGraph: kg, localBudgets: budgets, nowIso: () => "2026-11-28T18:25:00Z" });
    svc.ingestEdgeNodePulse({
      nodeId: "local-mac",
      atIso: "2026-11-28T18:24:30Z",
      projects: [{ projectKey: "repo:ldc861117/self-a-web", displayName: "self-a-web", tier: 2, status: "idle" }],
    });
    const readPromise = svc.readProjectGovernanceDoc({ projectQuery: "Andy-web", docPath: "docs/ROADMAP.md", timeoutMs: 3000 });
    await new Promise((r) => setTimeout(r, 30));
    const pulled = svc.edgeHub.pullPendingCommands("local-mac");
    expect(pulled[0]?.action).toBe("read_repo_doc");
    const ackRes = svc.edgeHub.ackCommand(pulled[0]!.id, {
      nodeId: "local-mac",
      status: "completed",
      docPath: "ROADMAP.md",
      docContent: "# Andy-web\n- [x] P3.1\n- [ ] P3.2",
    });
    expect(ackRes.ownerNotifyText).toBeUndefined();
    const liveDoc = await readPromise;
    expect(liveDoc.ok).toBe(true);
    expect(liveDoc.source).toBe("edge_live");

    const svcOffline = new SugentStewardHostService({ dataDir: makeTmp(), homeDir: dir, knowledgeGraph: kg, localBudgets: budgets, nowIso: () => "2026-11-28T18:25:00Z" });
    svcOffline.setRemoteOpsSnapshot({
      fetchedAtIso: "2026-11-28T18:00:00Z",
      pendingInbox: [],
      projects: [{
        projectKey: "repo:ldc861117/self-a-web",
        displayName: "self-a-web",
        tier: 2,
        roadmapSummary: { nodes: [{ id: "P3", code: "Phase 3", title: "机芯与管线", status: "active", items: [{ id: "P3.1", title: "3D机芯", status: "done", actor: "agent" }, { id: "P3.2", title: "活水", status: "todo", actor: "agent" }] }] },
      }],
    });
    const offlineDoc = await svcOffline.readProjectGovernanceDoc({ projectQuery: "Andy-web", docPath: "ROADMAP.md", timeoutMs: 1200 });
    expect(offlineDoc.ok).toBe(true);
    expect(offlineDoc.source).toBe("synced_snapshot_fallback");
    expect(String(offlineDoc.content)).toContain("P3.1");
  });

  it("bridges DSH amb-steward-fleet plugin over AgentBridge and blocks group chats", async () => {
    const dir = makeTmp();
    const repo = path.join(dir, "Projects", "self-a-web");
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, "ROADMAP.md"), "### Phase 3\n- [x] **P3.1 Done**\n- [ ] **P3.2 Next**\n");
    const store = new Store(":memory:");
    store.createBot({ id: "b1", name: "Sugent" });
    const dmConv = store.ensureConversation("b1", "web", "owner", "DM", "dm");
    store.setAgentSession(dmConv.id, "b1", "sess-dm-1");
    const grpConv = store.ensureConversation("b1", "web", "grp-1", "Group", "group");
    store.setAgentSession(grpConv.id, "b1", "sess-grp-1");

    const svc = new SugentStewardHostService({
      dataDir: dir,
      homeDir: dir,
      knowledgeGraph: new SugentKnowledgeGraph(path.join(dir, "kg")),
      localBudgets: new LocalBudgetLedger(dir),
    });
    const mgr = new AgentManager({
      store,
      dataDir: dir,
      runtimeDir: undefined,
      upstream: () => ({ baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" }),
      enabled: false,
      stewardFleetOp: (p) => svc.executeDshStewardFleetOp(p),
    });
    await mgr.bridge.start();
    const prevUrl = process.env.AMB_BRIDGE_URL;
    const prevTok = process.env.AMB_BRIDGE_TOKEN;
    const prevBot = process.env.AMB_BOT_ID;
    try {
      process.env.AMB_BRIDGE_URL = mgr.bridge.url;
      process.env.AMB_BRIDGE_TOKEN = mgr.bridge.token;
      process.env.AMB_BOT_ID = "b1";
      const pluginPath = path.resolve("dsh-runtime/plugins/amb-steward-fleet.mjs");
      const plugin = await import(pathToFileURL(pluginPath).href);
      let registeredTool: { execute: (args: any, exec: any) => Promise<{ text: string }> } | undefined;
      plugin.apply({
        tools: {
          register(tool: any) {
            if (tool?.name === "steward_fleet") registeredTool = tool;
          },
        },
      });
      expect(registeredTool).toBeDefined();

      const dmRes = await registeredTool!.execute(
        { action: "read_doc", projectQuery: "Andy-web", docPath: "ROADMAP.md" },
        { agent: { session: { id: "sess-dm-1" } }, signal: new AbortController().signal },
      );
      const dmJson = JSON.parse(dmRes.text) as Record<string, unknown>;
      expect(dmJson.ok).toBe(true);
      expect(String(dmJson.content)).toContain("P3.2 Next");

      const grpRes = await registeredTool!.execute(
        { action: "overview" },
        { agent: { session: { id: "sess-grp-1" } }, signal: new AbortController().signal },
      );
      const grpJson = JSON.parse(grpRes.text) as Record<string, unknown>;
      expect(grpJson.ok).toBe(false);
      expect(grpJson.errorCode).toBe("OWNER_PRIVATE_ONLY");
    } finally {
      if (prevUrl === undefined) delete process.env.AMB_BRIDGE_URL;
      else process.env.AMB_BRIDGE_URL = prevUrl;
      if (prevTok === undefined) delete process.env.AMB_BRIDGE_TOKEN;
      else process.env.AMB_BRIDGE_TOKEN = prevTok;
      if (prevBot === undefined) delete process.env.AMB_BOT_ID;
      else process.env.AMB_BOT_ID = prevBot;
      await mgr.stop();
      store.close();
    }
  });

  it("extracts gitSync divergence + TASKS.md (#slug/AC) queue in edge pulse & synthesizes offline TASKS.md", async () => {
    const tmp = makeTmp();
    const bare = path.join(tmp, "origin.git");
    const peer = path.join(tmp, "peer");
    const localParent = path.join(tmp, "Projects");
    const local = path.join(localParent, "demo-app");
    fs.mkdirSync(localParent, { recursive: true });
    const gitCfg = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];
    execFileSync("git", ["init", "--bare", "-b", "main", bare], { stdio: "ignore" });
    execFileSync("git", ["clone", bare, peer], { stdio: "ignore" });
    fs.writeFileSync(path.join(peer, "README.md"), "v1\n");
    execFileSync("git", ["-C", peer, ...gitCfg, "add", "README.md"], { stdio: "ignore" });
    execFileSync("git", ["-C", peer, ...gitCfg, "commit", "-m", "init"], { stdio: "ignore" });
    execFileSync("git", ["-C", peer, "push", "-u", "origin", "main"], { stdio: "ignore" });
    execFileSync("git", ["clone", bare, local], { stdio: "ignore" });

    fs.writeFileSync(path.join(peer, "README.md"), "v2\n");
    execFileSync("git", ["-C", peer, ...gitCfg, "commit", "-am", "remote update"], { stdio: "ignore" });
    execFileSync("git", ["-C", peer, "push", "origin", "main"], { stdio: "ignore" });
    execFileSync("git", ["-C", peer, "checkout", "-b", "feat/cloud-pr"], { stdio: "ignore" });
    fs.writeFileSync(path.join(peer, "pr.txt"), "pr\n");
    execFileSync("git", ["-C", peer, ...gitCfg, "add", "pr.txt"], { stdio: "ignore" });
    execFileSync("git", ["-C", peer, ...gitCfg, "commit", "-m", "cloud pr"], { stdio: "ignore" });
    execFileSync("git", ["-C", peer, "push", "-u", "origin", "feat/cloud-pr"], { stdio: "ignore" });

    execFileSync("git", ["-C", local, "fetch", "origin", "--prune"], { stdio: "ignore" });
    fs.writeFileSync(path.join(local, "ROADMAP.md"), "### 窗口 1（当前阶段）：核心底座\n- [/] W1.1 在途项\n- [-] W1.2 暂缓项\n");
    fs.writeFileSync(
      path.join(local, "TASKS.md"),
      [
        "# TASKS",
        "## Phase 1 (P1)",
        "- [/] [P1.1] 修复会话重连 #fix-session-reconnect",
        "    AC: 断网重连后 3 秒恢复心跳且零消息丢失。",
        "- [ ] [P1.2] 接入幂等网关 #add-idempotency-gate",
        "    AC: 并发重复回调仅入账一次。",
        "- [-] [P1.3] 暂缓次要重构 #defer-minor-refactor",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(local, "STATUS.md"), "---\nreview_state: pending_review\n---\n## 阶段目标\n完成 P1\n");
    execFileSync("git", ["-C", local, ...gitCfg, "add", "ROADMAP.md", "TASKS.md", "STATUS.md"], { stdio: "ignore" });
    execFileSync("git", ["-C", local, ...gitCfg, "commit", "-m", "local wip"], { stdio: "ignore" });
    fs.writeFileSync(path.join(local, "dirty.txt"), "dirty\n");

    const tk = parseRepoTasksMarkdown(fs.readFileSync(path.join(local, "TASKS.md"), "utf8"));
    expect(tk.counts).toEqual({ todo: 1, inProgress: 1, done: 0, blocked: 0, backlog: 1 });
    expect(tk.activeItems.map((x) => `${x.phaseCode}:${x.slug}`)).toEqual(["P1.1:fix-session-reconnect", "P1.2:add-idempotency-gate"]);
    expect(tk.activeItems[1]?.ac).toContain("仅入账一次");

    const scanned = scanLocalProjectsForEdge({ projectsRootDirs: [localParent], homeDir: tmp, nodeId: "local-mac", defaultTier: 2 });
    const proj = scanned.find((p) => p.displayName === "demo-app")!;
    expect(proj.roadmapSummary?.nodes?.[0]?.progress?.total).toBe(1);
    expect(proj.gitSync?.aheadCount).toBe(1);
    expect(proj.gitSync?.behindCount).toBe(1);
    expect(proj.gitSync?.dirtyCount).toBeGreaterThanOrEqual(1);
    expect(proj.gitSync?.unmergedRemoteBranches).toContain("origin/feat/cloud-pr");

    const svc = new SugentStewardHostService({
      dataDir: makeTmp(),
      homeDir: makeTmp(),
      knowledgeGraph: new SugentKnowledgeGraph(makeTmp()),
      localBudgets: new LocalBudgetLedger(makeTmp()),
      nowIso: () => "2026-11-28T19:05:00Z",
    });
    svc.ingestEdgeNodePulse({ nodeId: "local-mac", atIso: "2026-11-28T18:00:00Z", projects: [proj] });
    const ov = await svc.executeDshStewardFleetOp({ op: "overview" });
    expect((ov.gitSyncAlerts as any[])[0]?.aheadCount).toBe(1);
    const offlineTasks = await svc.readProjectGovernanceDoc({ projectQuery: "demo-app", docPath: "TASKS.md", timeoutMs: 1100 });
    expect(offlineTasks.ok).toBe(true);
    expect(offlineTasks.source).toBe("synced_snapshot_fallback");
    expect(String(offlineTasks.content)).toContain("#add-idempotency-gate");
  });
});
