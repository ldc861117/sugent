import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuthorizedFileReader,
  CapabilityAwarenessEngine,
  LocalBudgetLedger,
  ProjectPrivacyRegistry,
  STEWARD_CAPABILITY_DESCRIPTORS,
  StewardshipLedger,
  SugentKnowledgeGraph,
  SugentStewardHostService,
  formatCapabilityAwarenessPrompt,
} from "../src/sugent/index.js";

describe("CapabilityAwarenessEngine & AuthorizedFileReader", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  const makeTmp = (prefix: string) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(d);
    return d;
  };

  it("tracks build manifest evolution in KG, scans skills, and detects runtime build drift", () => {
    const dataDir = makeTmp("sugent-cap-data-");
    const manifestPath = path.join(dataDir, "sugent-build-manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ buildId: "0.1.15-aaa", version: "0.1.15", gitHead: "aaa", builtAtIso: "2026-11-21T03:00:00Z", builtAtMs: 1000, capabilityHighlights: ["全文读取", "能力自检"] }),
    );
    const skillDir = path.join(dataDir, "self-repo", "extensions", "skills", "my-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: my-skill\ndescription: Custom extended skill\n---\n# My Skill\n");

    const kg = new SugentKnowledgeGraph(path.join(dataDir, "kg"));
    const engine = new CapabilityAwarenessEngine({ dataDir, manifestPath, knowledgeGraph: kg, recordInKnowledgeGraph: true, tools: STEWARD_CAPABILITY_DESCRIPTORS });
    const snap1 = engine.snapshot(2);
    expect(snap1.recentEvolutions[0]?.buildId).toBe("0.1.15-aaa");
    expect(snap1.installedSkills.some((s) => s.name === "my-skill")).toBe(true);
    expect(snap1.drift.drifted).toBe(false);
    expect(kg.recallSubgraph("0.1.15-aaa", 1).matchedNodes.length).toBeGreaterThan(0);

    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ buildId: "0.1.15-bbb", version: "0.1.15", gitHead: "bbb", builtAtIso: "2026-11-21T04:00:00Z", builtAtMs: 2000, capabilityHighlights: ["新版能力"] }),
    );
    const snap2 = engine.snapshot(2);
    expect(snap2.drift.drifted).toBe(true);
    const promptBlock = formatCapabilityAwarenessPrompt(snap2, [{ alias: "Sugent", repoRoot: "/tmp/sugent" }]);
    expect(promptBlock).toContain("运行态版本漂移提示");
    expect(promptBlock).toContain("my-skill");
    expect(promptBlock).toContain("read_authorized_file");
  });

  it("reads full paginated .md reports beyond 750 chars while enforcing secret, symlink & privacy guards", () => {
    const dataDir = makeTmp("sugent-freader-data-");
    const homeDir = makeTmp("sugent-freader-home-");
    const projDir = path.join(homeDir, "repos", "airtoken");
    const privateDir = path.join(homeDir, "repos", "wallet-management");
    const outsideFile = path.join(makeTmp("sugent-ext-"), "host-secret.txt");
    fs.mkdirSync(path.join(projDir, "reports", "daily_reviews"), { recursive: true });
    fs.mkdirSync(privateDir, { recursive: true });
    fs.writeFileSync(outsideFile, "do-not-leak");

    const reviewText = `# Daily Review\n${"盈利归因详情行 1234567890。\n".repeat(260)}END_OF_REPORT`;
    const reviewFile = path.join(projDir, "reports", "daily_reviews", "2026-11-21_daily_review.md");
    fs.writeFileSync(reviewFile, reviewText);
    fs.writeFileSync(path.join(projDir, ".env"), "API_KEY=sk-test-secret");
    fs.symlinkSync(outsideFile, path.join(projDir, "reports", "leak.txt"));
    fs.writeFileSync(path.join(privateDir, "notes.md"), "private wallet notes");

    const privacyRegistry = new ProjectPrivacyRegistry({ dataDir });
    privacyRegistry.setProjectTier("repo:acme/wallet-management", 0);
    const kg = new SugentKnowledgeGraph(path.join(dataDir, "kg"));
    const ledger = new StewardshipLedger({ dataDir, knowledgeGraph: kg, budgetLedger: new LocalBudgetLedger(dataDir) });
    const reader = new AuthorizedFileReader({
      homeDir,
      privacyRegistry,
      ledger,
      getProjectRoots: () => [
        { projectKey: "repo:acme/airtoken", displayName: "airtoken", rootPath: projDir, sourceKind: "project_workspace" },
        { projectKey: "repo:acme/wallet-management", displayName: "wallet-management", rootPath: privateDir, sourceKind: "project_workspace" },
      ],
    });

    const hits = reader.searchFiles({ query: "2026-11-21_daily_review.md" });
    expect(hits[0]?.fileName).toBe("2026-11-21_daily_review.md");
    const page1 = reader.readFile({ fileQuery: "2026-11-21_daily_review.md", maxChars: 2000, offsetChars: 0 });
    expect(page1.ok).toBe(true);
    if (page1.ok) {
      expect(page1.totalChars).toBeGreaterThan(5000);
      expect(page1.returnedChars).toBe(2000);
      expect(page1.hasMore).toBe(true);
      const page2 = reader.readFile({ filePath: page1.absolutePath, maxChars: 6000, offsetChars: page1.nextOffsetChars });
      expect(page2.ok && page2.content.includes("END_OF_REPORT")).toBe(true);
    }
    expect(reader.readFile({ filePath: path.join(projDir, ".env") })).toMatchObject({ ok: false, errorCode: "SENSITIVE_FILE_BLOCKED" });
    expect(reader.readFile({ filePath: path.join(projDir, "reports", "leak.txt") })).toMatchObject({ ok: false, errorCode: "PATH_NOT_AUTHORIZED" });
    expect(reader.readFile({ filePath: path.join(privateDir, "notes.md"), callerDomain: "work_project" })).toMatchObject({ ok: false, errorCode: "TIER_0_LOCAL_ONLY" });
    expect(reader.readFile({ filePath: path.join(privateDir, "notes.md"), callerDomain: "owner_private" })).toMatchObject({ ok: true });
  });

  it("wires dynamic capability playbook and read_authorized_file tool inside StewardLlmAgent", async () => {
    const dataDir = makeTmp("sugent-llm-f-data-");
    const homeDir = makeTmp("sugent-llm-f-home-");
    const repoDir = path.join(homeDir, "repos", "airtoken");
    fs.mkdirSync(path.join(repoDir, "reports"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "reports", "2026-11-21_daily_review.md"), "# 复盘日报\n总盈亏 +42.8%\nFULL_BODY_VERIFIED");
    const cfgProjDir = path.join(homeDir, ".gemini", "config", "projects");
    fs.mkdirSync(cfgProjDir, { recursive: true });
    fs.writeFileSync(path.join(cfgProjDir, "airtoken.json"), JSON.stringify({ projectResources: { resources: [{ gitFolder: { folderUri: `file://${repoDir}` } }] } }));

    let llmRound = 0;
    let seenSysPrompt = "";
    let seenToolResult = "";
    const service = new SugentStewardHostService({
      dataDir,
      homeDir,
      knowledgeGraph: new SugentKnowledgeGraph(path.join(dataDir, "kg")),
      localBudgets: new LocalBudgetLedger(dataDir),
      getGatewayConfig: () => ({ mode: "external", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", unlockSubscriptions: false, privacyMasking: false, routing: { assessor: "m", executor: "m", computerUse: "m", steward: "m" } }),
      llmFetch: (async (_url, init) => {
        llmRound += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ role: string; content?: string }> };
        if (llmRound === 1) {
          seenSysPrompt = String(body.messages[0]?.content ?? "");
          return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "tc_1", type: "function", function: { name: "read_authorized_file", arguments: JSON.stringify({ action: "read", query: "2026-11-21_daily_review.md" }) } }] } }] }), { status: 200 });
        }
        seenToolResult = String(body.messages.at(-1)?.content ?? "");
        return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "已读取完整日报，总盈亏 +42.8%。" } }] }), { status: 200 });
      }) as typeof fetch,
    });

    const out = await service.converse({ text: "把 2026-11-21_daily_review.md 里的盈亏数字读给我看", callerDomain: "owner_private" });
    expect(out.intent).toBe("llm_agent");
    expect(seenSysPrompt).toContain("read_authorized_file");
    expect(seenToolResult).toContain("FULL_BODY_VERIFIED");
    expect(out.reply).toContain("+42.8%");
  });
});