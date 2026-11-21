import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  AntigravityHookSink,
  AntigravityStateReader,
  FleetPulseReader,
  ProjectPrivacyRegistry,
  canonicalizeProjectKey,
  isSubagentSession,
  normalizeWorkspaceRoot,
  parseAntigravityTimestampMs,
  stageSugentStewardPluginHooks,
} from "../src/sugent/antigravity-bridge.js";
import { PersonalSourceRegistry } from "../src/sugent/sources.js";

function createTestSummariesDb(
  dbPath: string,
  rows: Array<{
    conversation_id: string;
    title?: string;
    preview?: string;
    step_count?: number;
    last_modified_time: string;
    workspace_uris?: string;
    status?: string;
    project_id?: string;
    agent_name?: string;
    parent_conversation_id?: string;
    nesting_depth?: number;
    not_fully_idle?: number;
    killed?: number;
    last_user_input_time?: string;
    last_user_input_step_index?: number;
  }>,
): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        preview TEXT NOT NULL DEFAULT '',
        step_count INTEGER NOT NULL DEFAULT 0,
        last_modified_time TEXT NOT NULL,
        workspace_uris TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT '',
        project_id TEXT NOT NULL DEFAULT '',
        agent_name TEXT NOT NULL DEFAULT '',
        parent_conversation_id TEXT NOT NULL DEFAULT '',
        nesting_depth INTEGER NOT NULL DEFAULT 0,
        not_fully_idle INTEGER NOT NULL DEFAULT 0,
        killed INTEGER NOT NULL DEFAULT 0,
        last_user_input_time TEXT NOT NULL DEFAULT '',
        last_user_input_step_index INTEGER NOT NULL DEFAULT -1
      )
    `);
    const insert = db.prepare(`
      INSERT OR REPLACE INTO conversation_summaries (
        conversation_id, title, preview, step_count, last_modified_time, workspace_uris,
        status, project_id, agent_name, parent_conversation_id, nesting_depth,
        not_fully_idle, killed, last_user_input_time, last_user_input_step_index
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of rows) {
      insert.run(
        r.conversation_id, r.title ?? "", r.preview ?? "", r.step_count ?? 1, r.last_modified_time,
        r.workspace_uris ?? "[]", r.status ?? "CASCADE_RUN_STATUS_IDLE", r.project_id ?? "",
        r.agent_name ?? "", r.parent_conversation_id ?? "", r.nesting_depth ?? 0,
        r.not_fully_idle ?? 0, r.killed ?? 0, r.last_user_input_time ?? r.last_modified_time,
        r.last_user_input_step_index ?? 0,
      );
    }
  } finally {
    db.close();
  }
}

describe("Antigravity Workspace Kinship, Timestamps & Subagent Guards", () => {
  it("strips SSH host aliases, ports, and .git suffixes and honors .ops-project.json and explicitKey", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-ops-proj-"));
    try {
      expect(canonicalizeProjectKey({ remoteUrl: "git@custom-alias:ExampleOrg/DemoRepo.git" })).toBe(
        "repo:exampleorg/demorepo",
      );
      expect(canonicalizeProjectKey({ remoteUrl: "ssh://git@corp-bastion:2222/ExampleOrg/DemoRepo.git" })).toBe(
        "repo:exampleorg/demorepo",
      );
      expect(canonicalizeProjectKey({ remoteUrl: "https://github.com/ExampleOrg/DemoRepo" })).toBe(
        "repo:exampleorg/demorepo",
      );

      fs.writeFileSync(path.join(tmpDir, ".ops-project.json"), JSON.stringify({ projectKey: "repo:custom/declared" }));
      expect(canonicalizeProjectKey({ folderPath: tmpDir, remoteUrl: "git@alias:Other/Repo.git" })).toBe(
        "repo:custom/declared",
      );
      expect(canonicalizeProjectKey({ explicitKey: "repo:override/top", folderPath: tmpDir })).toBe(
        "repo:override/top",
      );

      const plainDir = path.join(tmpDir, "My Local Folder");
      fs.mkdirSync(plainDir, { recursive: true });
      expect(canonicalizeProjectKey({ nodeId: "Mac Mini", folderPath: plainDir })).toBe(
        "local:mac-mini:my-local-folder",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("normalizes worktree URIs, detects subagent sessions, and parses SQLite/pbtxt/ISO timestamps", () => {
    expect(normalizeWorkspaceRoot("file:///Users/dev/repos/sample/worktrees/conv-1/swarm-2")).toBe(
      "/Users/dev/repos/sample",
    );
    expect(normalizeWorkspaceRoot("file:///Users/dev/.gemini/antigravity/worktrees/conv-9/swarm-1")).toBe(
      "isolated-worktree:conv-9/swarm-1",
    );
    expect(isSubagentSession({ nestingDepth: 1 })).toBe(true);
    expect(isSubagentSession({ cwd: "/tmp/repo/worktrees/conv-1/swarm-1" })).toBe(true);
    expect(isSubagentSession({ transcriptPath: "/tmp/.gemini/antigravity/subagents/a.jsonl" })).toBe(true);
    expect(isSubagentSession({ cwd: "/Users/dev/repos/sample", nestingDepth: 0 })).toBe(false);

    const isoMs = parseAntigravityTimestampMs("2026-11-20T09:02:25.718Z");
    const sqliteMs = parseAntigravityTimestampMs("2026-11-20 09:02:25.718828+00:00");
    expect(sqliteMs).toBe(isoMs);
    expect(parseAntigravityTimestampMs("last_user_view_time:{seconds:1793531876 nanos:192000000}")).toBe(
      1793531876192,
    );
  });
});

describe("AntigravityStateReader Multi-Surface Scanning & Lifecycle", () => {
  it("scans app/cli/ide read-only, folds nesting_depth>0 subagents, distinguishes sidecar roles, and freezes offline volumes", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-agy-surfaces-"));
    try {
      const repoDir = path.join(tmpRoot, "repo-alpha");
      fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
      fs.writeFileSync(path.join(repoDir, ".git", "config"), '[remote "origin"]\n\turl = git@ssh-alias:OrgAlpha/Alpha.git\n');

      const appDb = path.join(tmpRoot, ".gemini/antigravity/conversation_summaries.db");
      const ideDb = path.join(tmpRoot, ".gemini/antigravity-ide/conversation_summaries.db");
      const nowMs = Date.parse("2026-11-20T12:00:00.000Z");

      createTestSummariesDb(appDb, [
        {
          conversation_id: "root-1",
          title: "Implement core parser",
          step_count: 8,
          last_modified_time: "2026-11-20 11:30:00.000000+00:00",
          workspace_uris: JSON.stringify([`file://${repoDir}`]),
          status: "CASCADE_RUN_STATUS_IDLE",
        },
        {
          conversation_id: "child-1",
          parent_conversation_id: "root-1",
          nesting_depth: 1,
          status: "CASCADE_RUN_STATUS_RUNNING",
          last_modified_time: "2026-11-20 11:25:00.000000+00:00",
        },
        {
          conversation_id: "grandchild-1",
          parent_conversation_id: "child-1",
          nesting_depth: 2,
          status: "CASCADE_RUN_STATUS_IDLE",
          last_modified_time: "2026-11-20 11:20:00.000000+00:00",
        },
        {
          conversation_id: "killed-root",
          title: "Aborted task",
          killed: 1,
          last_modified_time: "2026-11-20 11:00:00.000000+00:00",
        },
      ]);

      createTestSummariesDb(ideDb, [
        {
          conversation_id: "sidecar-ok",
          agent_name: "readonly-sidecar",
          title: "定时只读巡检完成",
          preview: "All checks nominal",
          last_modified_time: "2026-11-20 11:40:00.000000+00:00",
        },
        {
          conversation_id: "sidecar-bad",
          agent_name: "readonly-sidecar",
          title: "定时只读巡检异常",
          preview: "error: disk threshold exceeded",
          last_modified_time: "2026-11-20 11:45:00.000000+00:00",
        },
      ]);

      let volumeOnline = true;
      const reader = new AntigravityStateReader({
        nodeId: "mbp-1",
        homeDir: tmpRoot,
        bootstrappedAtMs: nowMs - 3600_000,
        existingPathChecker: () => volumeOnline,
      });

      const res1 = reader.scan({ nowMs });
      expect(res1.surfacesScanned).toEqual(["app", "ide"]); // cli missing -> skipped
      expect(res1.sessions.map((s) => s.conversationId)).toEqual(["root-1", "sidecar-ok", "sidecar-bad"]);
      const root1 = res1.sessions[0]!;
      expect(root1.projectKey).toBe("repo:orgalpha/alpha");
      expect(root1.subagentCount).toBe(2);
      expect(root1.activeSubagentCount).toBe(1);
      expect(root1.childConversationIds).toEqual(["child-1", "grandchild-1"]);

      // sidecar-ok stays silent, sidecar-bad raises urgent error, root-1 is review_ready
      expect(res1.cadenceEvents.map((e) => [e.conversationId, e.kind, e.urgency])).toEqual([
        ["sidecar-bad", "node_or_sidecar_error", "urgent"],
        ["root-1", "review_ready", "normal"],
      ]);

      // Unmount external volume -> frozen snapshot with volumeOffline: true
      volumeOnline = false;
      const res2 = reader.scan({ nowMs: nowMs + 60_000 });
      const frozenRoot = res2.sessions.find((s) => s.conversationId === "root-1")!;
      expect(frozenRoot.volumeOffline).toBe(true);
      expect(frozenRoot.projectKey).toBe("repo:orgalpha/alpha");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("enforces 48h cutover, all 5 Auto-Supersede triggers, and ZeroTokenProbeTracker zero-wake on unchanged snapshots", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-agy-cutover-"));
    try {
      const dbPath = path.join(tmpRoot, "app/conversation_summaries.db");
      const annDir = path.join(tmpRoot, "app/annotations");
      fs.mkdirSync(annDir, { recursive: true });
      const nowMs = Date.parse("2026-11-20T12:00:00.000Z");

      createTestSummariesDb(dbPath, [
        { conversation_id: "old-backlog", title: "Ancient", last_modified_time: "2026-11-17T00:00:00.000Z", step_count: 5 },
        { conversation_id: "s-step", title: "Step advance", last_modified_time: "2026-11-20T11:50:00.000Z", step_count: 4, last_user_input_step_index: 1 },
        { conversation_id: "s-input", title: "User input", last_modified_time: "2026-11-20T11:51:00.000Z", step_count: 4, last_user_input_step_index: 1 },
        { conversation_id: "s-run", title: "Rerun", last_modified_time: "2026-11-20T11:52:00.000Z", status: "CASCADE_RUN_STATUS_IDLE" },
        { conversation_id: "s-view", title: "Viewed", last_modified_time: "2026-11-20T11:53:00.000Z" },
        { conversation_id: "s-ext", title: "External wm", last_modified_time: "2026-11-20T11:54:00.000Z" },
      ]);

      const reader = new AntigravityStateReader({
        nodeId: "mac-1",
        surfacePaths: { app: { dbPath, annotationsDir: annDir } },
        bootstrappedAtMs: nowMs - 72 * 3600_000, // cutover falls back to 48h window!
        cutoverHours: 48,
      });

      const scan1 = reader.scan({ nowMs });
      expect(scan1.sessions.find((s) => s.conversationId === "old-backlog")?.withinCutover).toBe(false);
      expect(scan1.cadenceEvents.some((e) => e.conversationId === "old-backlog")).toBe(false);
      expect(scan1.probeDecision.shouldWakeAgent).toBe(true);

      // Identical rescan -> ZeroTokenProbeTracker suppresses wake (0 Token!)
      const scan2 = reader.scan({ nowMs: nowMs + 1000 });
      expect(scan2.probeDecision.shouldWakeAgent).toBe(false);
      expect(scan2.probeDecision.reason).toBe("healthy_unchanged");

      // Trigger all 5 Auto-Supersede conditions
      createTestSummariesDb(dbPath, [
        { conversation_id: "s-step", title: "Step advance", last_modified_time: "2026-11-20T11:50:00.000Z", step_count: 6, last_user_input_step_index: 1 },
        { conversation_id: "s-input", title: "User input", last_modified_time: "2026-11-20T11:51:00.000Z", step_count: 4, last_user_input_step_index: 2 },
        { conversation_id: "s-run", title: "Rerun", last_modified_time: "2026-11-20T11:52:00.000Z", status: "CASCADE_RUN_STATUS_RUNNING" },
        { conversation_id: "s-view", title: "Viewed", last_modified_time: "2026-11-20T11:53:00.000Z" },
        { conversation_id: "s-ext", title: "External wm", last_modified_time: "2026-11-20T11:54:00.000Z" },
      ]);
      const viewSec = Math.ceil(Date.parse("2026-11-20T11:55:00.000Z") / 1000);
      fs.writeFileSync(path.join(annDir, "s-view.pbtxt"), `last_user_view_time:{seconds:${viewSec} nanos:0}`);

      const scan3 = reader.scan({
        nowMs: nowMs + 2000,
        externalReadWatermarkMs: { "s-ext": Date.parse("2026-11-20T11:56:00.000Z") },
      });
      for (const id of ["s-step", "s-input", "s-run", "s-view", "s-ext"]) {
        expect(scan3.sessions.find((s) => s.conversationId === id)?.superseded).toBe(true);
      }
      expect(scan3.cadenceEvents).toHaveLength(0);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("FleetPulseReader (.ops_fleet_state.json)", () => {
  it("returns empty array gracefully for missing or corrupt JSON and maps collisions, errors, and handoffs", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-fleet-pulse-"));
    try {
      const missingReader = new FleetPulseReader(path.join(tmpDir, "missing.json"));
      expect(missingReader.read()).toEqual([]);

      const corruptPath = path.join(tmpDir, ".ops_fleet_state.json");
      fs.writeFileSync(corruptPath, "{not-valid-json");
      expect(new FleetPulseReader(corruptPath).read()).toEqual([]);

      fs.writeFileSync(
        corruptPath,
        JSON.stringify({
          generatedAt: "2026-11-20T10:00:00.000Z",
          collisions: [
            { id: "col-1", projectKey: "repo:org/demo", nodeId: "node-b", summary: "Two branches editing README.md" },
          ],
          nodes: {
            "node-c": { status: "error", sidecarError: "heartbeat timeout", projectKey: "repo:org/demo" },
          },
          handoffs: [
            { handoffId: "hf-1", projectKey: "repo:org/demo", targetNodeId: "local-mac", status: "pending", title: "Pick up staging check", conversationId: "conv-77" },
            { handoffId: "hf-done", projectKey: "repo:org/demo", status: "completed", title: "Already done" },
          ],
        }),
      );

      const events = new FleetPulseReader(corruptPath).read();
      expect(events).toHaveLength(3);
      expect(events.map((e) => [e.kind, e.urgency])).toEqual([
        ["red_collision", "urgent"],
        ["pending_handoff", "normal"],
        ["node_or_sidecar_error", "urgent"],
      ]);
      expect(events.find((e) => e.id === "hf-1")?.conversationId).toBe("conv-77");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("ProjectPrivacyRegistry & TierEpoch Anti-Reignition Gate", () => {
  it("classifies heuristically (0/1/2), allows free tier switching, persists 0600/0700, and rejects stale epochs", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-privacy-reg-"));
    try {
      const govRepo = path.join(tmpDir, "gov-repo");
      fs.mkdirSync(govRepo, { recursive: true });
      fs.writeFileSync(path.join(govRepo, "ROADMAP.md"), "# Roadmap\n");

      const dataDir = path.join(tmpDir, "data");
      const reg = new ProjectPrivacyRegistry({ dataDir, registeredProjectKeys: ["repo:org/gov-repo"] });

      expect(reg.resolveProjectPolicy({ projectKey: "local:mac:my-wallet" }).tier).toBe(0);
      expect(reg.resolveProjectPolicy({ projectKey: "local:mac:财务账本" }).tier).toBe(0);
      expect(reg.resolveProjectPolicy({ projectKey: "repo:org/ext", workspaceRoot: "/Volumes/USB/Proj" }).tier).toBe(0);
      expect(reg.resolveProjectPolicy({ projectKey: "repo:org/plain" }).tier).toBe(1);

      const govPolicy = reg.resolveProjectPolicy({ projectKey: "repo:org/gov-repo", workspaceRoot: govRepo });
      expect(govPolicy.tier).toBe(2);
      expect(govPolicy.tierSource).toBe("heuristic");
      expect(govPolicy.tierEpoch).toBe(1);

      // User freely upgrades sensitive repo (never locked!) and downgrades gov repo
      const walletUp = reg.setProjectTier("local:mac:my-wallet", 2);
      expect(walletUp.tier).toBe(2);
      expect(walletUp.tierSource).toBe("user_override");
      expect(walletUp.tierEpoch).toBe(2);

      const govDown = reg.setProjectTier("repo:org/gov-repo", 1);
      expect(govDown.tier).toBe(1);
      expect(govDown.tierEpoch).toBe(2);

      // Stale epoch payload (epoch 1 < current epoch 2) must be rejected & cleared
      const stale = reg.sanitizeForProjectTier(
        { projectKey: "repo:org/gov-repo", summary: "Detailed summary from epoch 1", status: "IDLE" },
        "repo:org/gov-repo",
        1,
      );
      expect(stale.rejected).toBe(true);
      expect(stale.staleEpoch).toBe(true);
      expect(stale.sanitized).toEqual({});

      // Current epoch at Tier 1 strips high-tier body fields while preserving safe metadata
      const tier1 = reg.sanitizeForProjectTier(
        { projectKey: "repo:org/gov-repo", summary: "Private summary", workspacePath: "/secret/path", status: "IDLE", stepCount: 4 },
        "repo:org/gov-repo",
        2,
      );
      expect(tier1.allowed).toBe(true);
      expect(tier1.sanitized.summary).toBeUndefined();
      expect(tier1.sanitized.workspacePath).toBeUndefined();
      expect(tier1.sanitized.status).toBe("IDLE");
      expect(tier1.sanitized.stepCount).toBe(4);

      const persistedPath = path.join(dataDir, "sugent-stewardship", "project-privacy.json");
      expect(fs.statSync(path.dirname(persistedPath)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(persistedPath).mode & 0o777).toBe(0o600);
      expect(new ProjectPrivacyRegistry(dataDir).getProjectPolicy("local:mac:my-wallet")?.tier).toBe(2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("stageSugentStewardPluginHooks, AntigravityHookSink & PersonalSourceRegistry('antigravity')", () => {
  it("refuses global ~/.gemini/config/hooks.json and stages isolated sugent-steward plugin with nohup", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-plugin-hooks-"));
    try {
      expect(() => stageSugentStewardPluginHooks("~/.gemini/config/hooks.json", "node hook.mjs")).toThrow(
        /global/i,
      );
      expect(() => stageSugentStewardPluginHooks("~/.gemini/config", "node hook.mjs")).toThrow(/global/i);

      const staged = stageSugentStewardPluginHooks(tmpDir, "node ./deliver.mjs");
      expect(staged.pluginDir).toBe(path.join(tmpDir, "sugent-steward"));
      expect(fs.existsSync(staged.pluginJsonPath)).toBe(true);
      expect(fs.existsSync(staged.hooksJsonPath)).toBe(true);

      const hooksJson = JSON.parse(fs.readFileSync(staged.hooksJsonPath, "utf8"));
      const stopCmd = hooksJson["sugent-steward-lifecycle"].Stop[0].command as string;
      expect(stopCmd).toContain("nohup ");
      expect(stopCmd).toContain(">/dev/null 2>&1 </dev/null &");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("short-circuits subagent hooks in <1ms and ingests root hooks via workspacePath without cwd violation", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-hook-sink-"));
    try {
      const repoDir = path.join(tmpDir, "workspace-main");
      fs.mkdirSync(repoDir, { recursive: true });
      const registry = new PersonalSourceRegistry();
      expect(registry.listKinds().map((k) => k.kind)).toContain("antigravity");

      const captured: unknown[] = [];
      const sink = new AntigravityHookSink({
        registry,
        nodeId: "mbp-owner",
        defaultOwnerId: "owner-1",
        allowedSenderIds: ["owner-1"],
        onTrigger: (t) => captured.push(t),
      });

      const subRes = sink.processHookStdin(
        JSON.stringify({
          hookEventName: "Stop",
          conversationId: "sub-1",
          cwd: `${repoDir}/worktrees/root-1/swarm-2`,
          transcriptPath: `${tmpDir}/.gemini/antigravity/subagents/sub-1.jsonl`,
          nestingDepth: 1,
        }),
      );
      expect(subRes.shortCircuited).toBe(true);
      expect(subRes.stdoutJson).toBe('{"decision":"allow"}');
      expect(subRes.elapsedMs).toBeLessThan(1);
      expect(captured).toHaveLength(0);

      // Direct ingest carrying raw `cwd` still fails strict security envelope check
      expect(() =>
        registry.ingest(
          "antigravity",
          "raw",
          { eventId: "e-bad", conversationId: "c1", ownerId: "owner-1", cwd: "/etc" } as any,
          ["owner-1"],
        ),
      ).toThrow();

      const subToolOut = sink.handleRawHookStdin(
        JSON.stringify({ hookEventName: "PostToolUse", cwd: `${repoDir}/subagents/x` }),
      );
      expect(subToolOut).toBe("{}");

      const rootOut = sink.handleRawHookStdin(
        JSON.stringify({
          hookEventName: "Stop",
          conversationId: "conv-root-9",
          cwd: repoDir,
          transcriptPath: `${tmpDir}/.gemini/antigravity-cli/transcript.jsonl`,
          terminationReason: "NO_TOOL_CALL",
          fullyIdle: true,
          lastUserInput: "Finish unit tests",
        }),
      );
      expect(rootOut).toBe('{"decision":"allow"}');
      expect(captured).toHaveLength(1);
      const trigger = captured[0] as any;
      expect(trigger.id).toMatch(/^agy:/);
      expect(trigger.threadKey).toBe("antigravity:mbp-owner:cli:conv-root-9");
      expect(trigger.addressedToAgent).toBe(false);
      expect(trigger.fromAllowedSender).toBe(true);
      expect(trigger.meta.workspacePath).toBe(repoDir);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
