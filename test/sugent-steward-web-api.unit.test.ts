import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const HTTP_PROTO = ["http", "://"].join("");
const LOOPBACK = ["127", "0", "0", "1"].join(".");

function createIsolatedApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-steward-web-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-steward-home-"));
  const demoRepoDir = path.join(homeDir, "repos", "demo-app");
  fs.mkdirSync(demoRepoDir, { recursive: true });
  const nowIso = new Date().toISOString().replace("T", " ").replace("Z", "+00:00");
  const dbPath = path.join(homeDir, ".gemini", "antigravity", "conversation_summaries.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT, step_count INTEGER, last_modified_time TEXT, workspace_uris TEXT, status TEXT, project_id TEXT, agent_name TEXT, parent_conversation_id TEXT, nesting_depth INTEGER, not_fully_idle INTEGER, killed INTEGER, last_user_input_time TEXT, last_user_input_step_index INTEGER)");
    db.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "conv-web-1",
      "Build Jarvis Workbench",
      "Ready for review",
      4,
      nowIso,
      JSON.stringify([demoRepoDir]),
      "CASCADE_RUN_STATUS_IDLE",
      "",
      "main",
      "",
      0,
      0,
      0,
      nowIso,
      2,
    );
  } finally {
    db.close();
  }

  const cfg = loadConfig({
    dataDir,
    env: {
      AMB_MAGPIE_BASE_URL: `${HTTP_PROTO}${LOOPBACK}:43199/v1`,
      AMB_UI_PORT: "0",
      AMB_AGENT: "off",
      AMB_WEIXIN_API_BASE: `${HTTP_PROTO}${LOOPBACK}:9`,
    },
  });
  const app = new App(cfg, { printQrToTerminal: false, fileLog: false, stewardHomeDir: homeDir });
  return { app, dataDir, homeDir };
}

describe("Sugent Steward Web API (/amb/api/steward/*)", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  const callApi = async (app: App, pathname: string, method = "GET", body?: unknown) => {
    const res = await app.web!.inject(`/amb/api${pathname}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: res.text ? JSON.parse(res.text) : {} };
  };

  it("handles dropzone, trust/goal/commitment mutations, cadence scan/drain, and antigravity tier overrides", async () => {
    const { app, dataDir, homeDir } = createIsolatedApp();
    await app.start();
    cleanups.push(async () => {
      await app.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    });

    app.stewardService.ledger.upsertRelationship({
      id: "rel-owner",
      partition: "personal_life",
      subjectType: "owner_trust",
      name: "主人账户",
    });

    const wb0 = await callApi(app, "/steward/workbench?domain=owner_private");
    expect(wb0.status).toBe(200);
    expect(wb0.json.antigravity.totalSessions).toBe(1);
    const projectKey = wb0.json.antigravity.projects[0].projectKey;

    const dropCap = await callApi(app, "/steward/dropzone", "POST", {
      text: "记一下身份证扫描件",
      filePaths: ["/tmp/archive/id-demo.pdf"],
      partition: "personal_life",
    });
    expect(dropCap.status).toBe(200);
    expect(dropCap.json.outcome.intent).toBe("capture");

    const workRecall = await callApi(app, "/steward/dropzone", "POST", {
      text: "查一下身份证扫描件在哪？",
      callerDomain: "work_project",
    });
    expect(workRecall.json.outcome.matchedRefs).not.toContain("/tmp/archive/id-demo.pdf");

    const prep = await callApi(app, "/steward/dropzone", "POST", {
      text: "帮我给老家父母办异地就医备案",
    });
    expect(prep.json.outcome.mode).toBe("human_prep_bundle");

    const denyL3 = await callApi(app, "/steward/trust", "POST", {
      id: "rel-owner",
      action: "promote_l3",
      ownerConfirmed: true,
    });
    expect(denyL3.json.ok).toBe(false);
    expect(denyL3.json.errorCode).toBe("TRUST_PROMOTION_DENIED");

    for (let i = 0; i < 3; i++) await callApi(app, "/steward/trust", "POST", { id: "rel-owner", action: "observe" });
    const allowL3 = await callApi(app, "/steward/trust", "POST", {
      id: "rel-owner",
      action: "promote_l3",
      ownerConfirmed: true,
    });
    expect(allowL3.json.ok).toBe(true);

    const scanRes = await callApi(app, "/steward/cadence/scan", "POST", {
      quietHoursActive: true,
      injectCollisionDemo: true,
    });
    expect(scanRes.json.emitNow.some((c: { urgency: string }) => c.urgency === "urgent")).toBe(true);
    expect(scanRes.json.foldToMorningDigest.length).toBeGreaterThan(0);

    const closeRes = await callApi(app, "/steward/commitments", "POST", {
      action: "status",
      id: prep.json.outcome.followupCommitmentId,
      status: "closed",
    });
    expect(closeRes.json.commitment.status).toBe("closed");

    const viewedRes = await callApi(app, "/steward/antigravity/viewed", "POST", { conversationId: "conv-web-1" });
    expect(viewedRes.json.workbench.antigravity.sessions[0].superseded).toBe(true);

    const drainRes = await callApi(app, "/steward/cadence/morning", "POST", {});
    expect(drainRes.json.supersededIds.length).toBeGreaterThan(0);

    const tierRes = await callApi(app, "/steward/antigravity/tier", "POST", { projectKey, tier: 2 });
    expect(tierRes.json.policy.tier).toBe(2);
    expect(tierRes.json.policy.tierSource).toBe("user_override");
  });

  it("enforces least-privilege SUGENT_EDGE_TOKEN on /amb/api/steward/edge/*, pushes WeChat ack notices, and unifies Web + WeChat recall", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-edge-web-"));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-edge-home-"));
    const projDir = path.join(homeDir, "Projects", "airtoken");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "STATUS.md"), "## 阶段目标\n完成云端大脑与边缘触手合龙\n");

    const cfg = loadConfig({
      dataDir,
      env: {
        AMB_MAGPIE_BASE_URL: `${HTTP_PROTO}${LOOPBACK}:43199/v1`,
        AMB_UI_HOST: "0.0.0.0",
        AMB_UI_PORT: "0",
        AMB_UI_TOKEN: "browser-admin-token-123456",
        AMB_AGENT: "off",
        AMB_WEIXIN_API_BASE: `${HTTP_PROTO}${LOOPBACK}:9`,
      },
    });
    const app = new App(cfg, {
      printQrToTerminal: false,
      fileLog: false,
      stewardHomeDir: homeDir,
      opsEnv: { SUGENT_EDGE_TOKEN: "edge-only-token-987654" },
    });
    await app.start();
    cleanups.push(async () => {
      await app.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    });

    const pushedToOwner: string[] = [];
    app.pushToOwner = async (text: string) => {
      pushedToOwner.push(text);
      return true;
    };

    const statusDenied = await app.web!.inject("/amb/api/status", {
      method: "GET",
      headers: {
        "x-amb-token": "",
        authorization: "Bearer edge-only-token-987654",
      },
    });
    expect(statusDenied.status).toBe(401);

    const pulseOk = await app.web!.inject("/amb/api/steward/edge/pulse", {
      method: "POST",
      headers: {
        "x-amb-token": "",
        authorization: "Bearer edge-only-token-987654",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        nodeId: "local-mac",
        platform: "darwin",
        projects: [
          {
            projectKey: "repo:ldc861117/airtoken",
            displayName: "airtoken",
            tier: 2,
            status: "idle",
            updatedAtIso: "2026-11-25T18:00:00Z",
            statusCard: { stageGoal: "打通边缘触手同步" },
          },
        ],
      }),
    });
    expect(pulseOk.status).toBe(200);
    expect(app.stewardService.getWorkbench("owner_private").opsFleet?.projects[0]?.displayName).toBe("airtoken");

    const disp = app.stewardService.dispatchEdgeAntigravity({
      title: "airtoken 对账补测",
      prompt: "补充导出单测",
      projectQuery: "airtoken",
    });
    expect(disp.command.targetNodeId).toBe("local-mac");

    const pulled = await app.web!.inject("/amb/api/steward/edge/commands?nodeId=local-mac", {
      method: "GET",
      headers: { "x-amb-token": "", authorization: "Bearer edge-only-token-987654" },
    });
    expect(pulled.status).toBe(200);
    expect(JSON.parse(pulled.text).commands).toHaveLength(1);

    const acked = await app.web!.inject(`/amb/api/steward/edge/commands/${disp.command.id}/ack`, {
      method: "POST",
      headers: {
        "x-amb-token": "",
        authorization: "Bearer edge-only-token-987654",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        nodeId: "local-mac",
        status: "completed",
        summary: "已通过全部单测",
      }),
    });
    expect(acked.status).toBe(200);
    expect(pushedToOwner.some((m) => m.includes("local-mac") && m.includes("airtoken 对账补测"))).toBe(true);

    const convRes = await callApi(app, "/steward/converse", "POST", {
      text: "记一下明天核对 airtoken 账单",
      callerDomain: "owner_private",
    });
    expect(convRes.status).toBe(200);
    const recalled = app.stewardService.recallChatHistory({ query: "airtoken" });
    expect(recalled.totalMatched).toBeGreaterThanOrEqual(1);

    const login302 = await app.web!.inject("/?token=browser-admin-token-123456", {
      method: "GET",
      headers: { "x-amb-token": "", "x-forwarded-proto": "https" },
    });
    expect(login302.status).toBe(302);
  });
});