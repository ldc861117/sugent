import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactComprehensionPipeline,
  AntigravityDispatcher,
  CausalLedger,
  LocalBudgetLedger,
  LocalDiffCanonPublisher,
  PrivacyFilteredOpsProjectionSink,
  ProjectPrivacyRegistry,
  StewardshipLedger,
  SugentKnowledgeGraph,
  SugentStewardHostService,
  SuspendedRoundStore,
  type AgentApiRunner,
} from "../src/sugent/index.js";

describe("Sprint 3: ArtifactComprehensionPipeline, AntigravityDispatcher & Projection/Canon", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  const makeTmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-s3-bridge-"));
    dirs.push(d);
    return d;
  };

  it("enforces 0400 security envelope, Tier 0 privacy gating, and suspended approval in ArtifactComprehensionPipeline", async () => {
    const tmp = makeTmp();
    const home = path.join(tmp, "home");
    const brainDir = path.join(home, ".gemini", "antigravity", "brain", "conv-s3-1");
    fs.mkdirSync(brainDir, { recursive: true });
    fs.writeFileSync(path.join(brainDir, "implementation_plan.md"), "# 迁移方案\n已完成测试 passed");
    fs.writeFileSync(path.join(brainDir, "walkthrough.md"), "## 结果\n29 tests passed");

    const ledger = new StewardshipLedger({ dataDir: tmp });
    ledger.upsertGoal({ id: "g1", partition: "work_project", title: "迁移方案", northStarCriterion: "passed" });
    const privacy = new ProjectPrivacyRegistry({ dataDir: tmp, registeredProjectKeys: ["repo:acme/app"] });
    const suspendedStore = new SuspendedRoundStore(tmp);
    const pipeline = new ArtifactComprehensionPipeline({
      homeDir: home,
      sealWorkspaceDir: path.join(tmp, "ws"),
      privacyRegistry: privacy,
      ledger,
      suspendedStore,
    });

    privacy.setProjectTier("repo:acme/app", 0);
    const denied = await pipeline.comprehendSession({ conversationId: "conv-s3-1", projectKey: "repo:acme/app", callerDomain: "work_project" });
    expect(denied.allowed).toBe(false);

    privacy.setProjectTier("repo:acme/app", 2);
    const res = await pipeline.comprehendSession({ conversationId: "conv-s3-1", projectKey: "repo:acme/app", title: "迁移重构", callerDomain: "owner_private" });
    expect(res.allowed).toBe(true);
    if (res.allowed) {
      expect(fs.statSync(res.envelope.absoluteFilePath).mode & 0o777).toBe(0o400);
      expect(res.artifactsFound).toContain("implementation_plan.md");
      expect(res.requiresApproval).toBe(true);
      expect(res.suspendedRoundId).toBeTruthy();
      expect(suspendedStore.listPending().some((c) => c.roundId === res.suspendedRoundId)).toBe(true);
    }
  });
  it("enforces agentapi guards (root-only, sidecar workspace whitelist, 8-hop circuit breaker), canon diff, ops sink, and static source scan", async () => {
    const tmp = makeTmp();
    const sidecarsDir = path.join(tmp, "sidecars");
    const allowedRepo = path.join(tmp, "repos", "allowed-proj");
    fs.mkdirSync(path.join(sidecarsDir, "daily"), { recursive: true });
    fs.mkdirSync(allowedRepo, { recursive: true });
    fs.writeFileSync(path.join(sidecarsDir, "daily", "sidecar.json"), JSON.stringify({ agent_permissions: { workspace_uris: [`file://${allowedRepo}`] } }));

    const causalLedger = new CausalLedger(tmp);
    const runnerCalls: string[] = [];
    const runner: AgentApiRunner = {
      async getConversationMetadata(id) {
        runnerCalls.push(`meta:${id}`);
        if (id === "sub-conv") return { exists: true, parentConversationId: "root-conv", nestingDepth: 1, workspaceUris: [allowedRepo] };
        if (id === "root-conv") return { exists: true, nestingDepth: 0, workspaceUris: [allowedRepo] };
        return { exists: false };
      },
      async sendMessage(p) {
        runnerCalls.push(`send:${p.recipientId}:${p.content}`);
        return { ok: true, exitCode: 0 };
      },
      async newConversation(p) {
        runnerCalls.push(`new:${p.prompt}`);
        return { conversationId: "new-conv-123", exitCode: 0 };
      },
    };

    const dispatcher = new AntigravityDispatcher({ runner, causalLedger, sidecarsDir });
    const subDenied = await dispatcher.resumeSession({ conversationId: "sub-conv", content: "hi" });
    expect(subDenied.errorCode).toBe("SUBAGENT_DISPATCH_FORBIDDEN");
    const outOfScope = await dispatcher.startNewSession({ prompt: "run", workspacePath: path.join(tmp, "other-dir") });
    expect(outOfScope.errorCode).toBe("WORKSPACE_NOT_ALLOWED");
    const hopped = await dispatcher.resumeSession({ conversationId: "root-conv", content: "loop", hopCount: 9 });
    expect(hopped.errorCode).toBe("HOP_CIRCUIT_BROKEN");
    expect(causalLedger.traceRound(hopped.roundId)?.status).toBe("circuit_broken");

    const okResume = await dispatcher.resumeSession({ conversationId: "root-conv", content: "继续跑单测" });
    expect(okResume.ok).toBe(true);
    const okNew = await dispatcher.startNewSession({ prompt: "新巡检", workspacePath: allowedRepo, model: "flash", title: "巡检" });
    expect(okNew.ok && okNew.conversationId === "new-conv-123").toBe(true);
    expect(runnerCalls).toContain("send:root-conv:继续跑单测");

    const pub = new LocalDiffCanonPublisher();
    const draft = { canonId: "c1", title: "公开说明", slug: "public-note", markdownBody: "已完成架构验证", privacyTier: "summary_allowed" as const, sourceRefs: [], unifiedDiffPreview: "" };
    const dry = await pub.dryRunDiff(draft);
    await expect(pub.publishCanon(draft, "wrong")).rejects.toThrow(/mismatch/);
    const published = await pub.publishCanon(draft, dry.confirmHash);
    expect(published.publishedUrl).toBe("canon://local/public-note");

    const priv = new ProjectPrivacyRegistry({ dataDir: tmp });
    priv.setProjectTier("repo:x/t0", 0);
    const t1 = priv.setProjectTier("repo:x/t1", 1);
    const t2 = priv.setProjectTier("repo:x/t2", 2);
    const sink = new PrivacyFilteredOpsProjectionSink(priv);
    await sink.projectSnapshot({
      snapshotId: "s1",
      generatedAt: "2026-11-20T12:00:00.000Z",
      privacyTier: "summary_allowed",
      projectCounts: { active: 3, waitingReview: 0, offlineVolumes: 0 },
      items: [
        { projectKey: "repo:x/t0", status: "idle", updatedAt: "2026-11-20T12:00:00.000Z", sanitizedSummary: "hidden0" },
        { projectKey: "repo:x/t1", status: "running", updatedAt: "2026-11-20T12:00:00.000Z", sanitizedSummary: "hidden1", tierEpoch: t1.tierEpoch },
        { projectKey: "repo:x/t2", status: "waiting_review", updatedAt: "2026-11-20T12:00:00.000Z", sanitizedSummary: "ok2", tierEpoch: t2.tierEpoch },
      ],
    });
    const outItems = sink.acceptedSnapshots[0]!.items;
    expect(outItems.some((i) => i.projectKey === "repo:x/t0")).toBe(false);
    expect(outItems.find((i) => i.projectKey === "repo:x/t1")?.sanitizedSummary).toBeUndefined();
    expect(outItems.find((i) => i.projectKey === "repo:x/t2")?.sanitizedSummary).toBe("ok2");

    const forbidden = [["meta", "mirror"].join(""), ["clikey", "-"].join(""), ["35.253", "88.118"].join(".")];
    const srcDir = path.resolve("src/sugent");
    for (const file of fs.readdirSync(srcDir).filter((f) => f.endsWith(".ts"))) {
      const content = fs.readFileSync(path.join(srcDir, file), "utf8");
      for (const tok of forbidden) expect(content.includes(tok), `${file} leaked ${tok}`).toBe(false);
    }
  });

  it("resolves Antigravity project display names over git remote slugs and reports live running child/transcript progress without false approval", async () => {
    const tmp = makeTmp();
    const home = path.join(tmp, "home");
    const repoDir = path.join(tmp, "Projects", "Alpha-Web");
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/org/legacy-slug.git\n');
    const projDir = path.join(home, ".gemini", "config", "projects");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "proj-alpha.json"), JSON.stringify({ id: "proj-alpha", name: "Alpha-Web", projectResources: { resources: [{ gitFolder: { folderUri: `file://${repoDir}` } }] } }));

    const dbPath = path.join(home, ".gemini", "antigravity", "conversation_summaries.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const nowIso = new Date().toISOString().replace("T", " ").replace("Z", "+00:00");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT, step_count INTEGER, last_modified_time TEXT, workspace_uris TEXT, status TEXT, project_id TEXT, agent_name TEXT, parent_conversation_id TEXT, nesting_depth INTEGER, not_fully_idle INTEGER, killed INTEGER, last_user_input_time TEXT, last_user_input_step_index INTEGER)");
      const ins = db.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      ins.run("conv-alpha-root", "Site Redesign", "Running checks", 590, nowIso, JSON.stringify([`file://${repoDir}`]), "CASCADE_RUN_STATUS_IDLE", "proj-alpha", "main", "", 0, 1, 0, nowIso, 460);
      ins.run("conv-alpha-sub", "", "", 22, nowIso, JSON.stringify([`file://${repoDir}`]), "CASCADE_RUN_STATUS_RUNNING", "proj-alpha", "sub", "conv-alpha-root", 1, 1, 0, "", -1);
    } finally {
      db.close();
    }
    const rootLogs = path.join(home, ".gemini", "antigravity", "brain", "conv-alpha-root", ".system_generated", "logs");
    const subLogs = path.join(home, ".gemini", "antigravity", "brain", "conv-alpha-sub", ".system_generated", "logs");
    fs.mkdirSync(rootLogs, { recursive: true });
    fs.mkdirSync(subLogs, { recursive: true });
    fs.writeFileSync(path.join(home, ".gemini", "antigravity", "brain", "conv-alpha-root", "implementation_plan.md"), "# V4 改版方案");
    fs.writeFileSync(path.join(rootLogs, "transcript.jsonl"), `${JSON.stringify({ step_index: 590, type: "GENERIC", status: "RUNNING", content: "等待浏览器验收子代理" })}\n`);
    fs.writeFileSync(path.join(subLogs, "transcript.jsonl"), `${JSON.stringify({ step_index: 22, type: "PLANNER_RESPONSE", status: "DONE", content: "正在校验首页陀飞轮视觉还原" })}\n`);

    const svc = new SugentStewardHostService({ dataDir: tmp, homeDir: home, knowledgeGraph: new SugentKnowledgeGraph(path.join(tmp, "kg")), localBudgets: new LocalBudgetLedger(tmp) });
    const wb = svc.getWorkbench("owner_private");
    const sess = wb.antigravity.sessions.find((s) => s.conversationId === "conv-alpha-root")!;
    expect(sess.projectKey).toBe("repo:org/legacy-slug");
    expect(sess.projectDisplayName).toBe("Alpha-Web");
    expect(sess.isRunning).toBe(true);
    expect(wb.antigravity.projects[0]?.displayName).toBe("Alpha-Web");
    expect(wb.antigravity.projects[0]?.runningSessionCount).toBe(1);

    const comp = await svc.comprehendSession({ conversationId: "conv-alpha-root", projectKey: sess.projectKey });
    expect(comp.allowed).toBe(true);
    if (comp.allowed) {
      expect(comp.projectDisplayName).toBe("Alpha-Web");
      expect(comp.runState).toBe("running");
      expect(comp.requiresApproval).toBe(false);
      expect(comp.livePulse.runningTaskSnippets.length).toBeGreaterThan(0);
      expect(comp.livePulse.activeChildActivities[0]).toContain("陀飞轮");
    }
  });
});
