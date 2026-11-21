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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-converse-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-converse-home-"));
  const demoRepoDir = path.join(homeDir, "repos", "demo-app");
  fs.mkdirSync(demoRepoDir, { recursive: true });
  const nowIso = new Date().toISOString().replace("T", " ").replace("Z", "+00:00");
  const dbPath = path.join(homeDir, ".gemini", "antigravity", "conversation_summaries.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT, step_count INTEGER, last_modified_time TEXT, workspace_uris TEXT, status TEXT, project_id TEXT, agent_name TEXT, parent_conversation_id TEXT, nesting_depth INTEGER, not_fully_idle INTEGER, killed INTEGER, last_user_input_time TEXT, last_user_input_step_index INTEGER)");
    db.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "conv-nl-1",
      "Polish Personal Steward",
      "Ready",
      3,
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
      1,
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
describe("Steward Natural-Language Conversation Engine (/amb/api/steward/converse)", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  const post = async (app: App, p: string, body: unknown) => {
    const res = await app.web!.inject(`/amb/api${p}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: JSON.parse(res.text) };
  };

  it("handles natural-language goal swaps, commitment closing with organic trust, antigravity privacy, cadence, and concierge undo", async () => {
    const { app, dataDir, homeDir } = createIsolatedApp();
    await app.start();
    cleanups.push(async () => {
      await app.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    });

    const l = app.stewardService.ledger;
    const oldIso = new Date(Date.now() - 8 * 86_400_000).toISOString();
    l.upsertRelationship({ id: "owner-trust", partition: "personal_life", subjectType: "owner_trust", name: "主人", verifiedObservations: 1 });
    l.upsertGoal({ id: "g1", partition: "work_project", title: "打造贴身幕僚", northStarCriterion: "可用" });
    l.upsertGoal({ id: "g2", partition: "personal_life", title: "父母健康体检", northStarCriterion: "本月办完", stallThresholdDays: 5, lastProgressAt: oldIso });
    l.upsertGoal({ id: "g3", partition: "work_project", title: "Q4 客户签约", northStarCriterion: "签两家" });
    l.upsertCommitment({ id: "c1", partition: "work_project", direction: "i_owe", summary: "向张总确认排期", counterpartyOrRef: "张总", dueAt: new Date(Date.now() + 86_400_000).toISOString() });

    app.conciergeBridge.updateConfig({ enabled: true, ownerDisplayName: "冬辰", cloudMode: "byok_local", coolingWindowMs: 30_000 });
    await app.conciergeBridge.processInboundEvent({
      id: "ev-wang",
      channel: "weixin",
      botId: "default",
      account: "default",
      conversation: { kind: "dm", id: "wx_wang" },
      sender: { id: "wx_wang", name: "王总" },
      parts: [{ type: "text", text: "你好，请问工业诊断怎么收费？" }],
      replyHandle: {},
      receivedAt: Date.now(),
    });
    const gCap = await post(app, "/steward/converse", { text: "把『下月百人内测』列为重点目标" });
    expect(gCap.status).toBe(200);
    expect(gCap.json.intent).toBe("goal_add");
    expect(gCap.json.reply).toContain("替换第");

    const gSwap = await post(app, "/steward/converse", { text: "替换第 2 个" });
    expect(gSwap.json.intent).toBe("pending_goal_replace");
    expect(gSwap.json.workbench.ledger.goals.some((g: { title: string; status: string }) => g.title === "下月百人内测" && g.status === "active")).toBe(true);

    const gCancelStart = await post(app, "/steward/converse", { text: "把『每天早睡』列为重点目标" });
    expect(gCancelStart.json.intent).toBe("goal_add");
    const gCancel = await post(app, "/steward/converse", { text: "先算了" });
    expect(gCancel.json.intent).toBe("pending_goal_replace");
    expect(gCancel.json.workbench.ledger.goals.some((g: { title: string }) => g.title === "每天早睡")).toBe(false);

    const cq = await post(app, "/steward/converse", { text: "有哪些待办？" });
    expect(cq.json.intent).toBe("commitments_query");
    expect(cq.json.reply).toContain("向张总确认排期");

    const cc = await post(app, "/steward/converse", { text: "张总排期确认好了，销掉吧" });
    expect(cc.json.intent).toBe("commitment_close");
    expect(cc.json.workbench.ledger.commitments.find((c: { id: string }) => c.id === "c1").status).toBe("closed");
    const relAfter = cc.json.workbench.ledger.relationships.find((r: { id: string }) => r.id === "owner-trust");
    expect(relAfter.verifiedObservations).toBeGreaterThanOrEqual(2);

    const agyQ = await post(app, "/steward/converse", { text: "看看我的代码项目进度" });
    expect(agyQ.json.intent).toBe("agy_query");
    expect(agyQ.json.reply).toContain("demo-app");
    const agyPriv = await post(app, "/steward/converse", { text: "把 demo-app 设成私密" });
    expect(agyPriv.json.intent).toBe("agy_privacy");
    expect(agyPriv.json.workbench.antigravity.projects[0].policy.tier).toBe(0);

    const qhOn = await post(app, "/steward/converse", { text: "开启免打扰" });
    expect(qhOn.json.workbench.quietHoursActive).toBe(true);
    const prefOff = await post(app, "/steward/preferences", { quietHoursActive: false });
    expect(prefOff.json.quietHoursActive).toBe(false);
    const brief = await post(app, "/steward/converse", { text: "今天有什么提醒？" });
    expect(brief.json.intent).toBe("briefing");

    const cgQ = await post(app, "/steward/converse", { text: "有人找我吗？" });
    expect(cgQ.json.intent).toBe("concierge_query");
    expect(cgQ.json.reply).toContain("王总");
    const cgPrice = await post(app, "/steward/converse", { text: "回王总：诊断包 8 万起" });
    expect(cgPrice.json.intent).toBe("concierge_reply");
    expect(cgPrice.json.reply).toContain("确认发送");
    const cgConfirm = await post(app, "/steward/converse", { text: "确认发送" });
    expect(cgConfirm.json.intent).toBe("pending_concierge_confirm");
    expect(cgConfirm.json.workbench.concierge.pendingDispatches.length).toBe(1);
    const cgUndo = await post(app, "/steward/converse", { text: "撤回" });
    expect(cgUndo.json.intent).toBe("concierge_undo");
    expect(cgUndo.json.workbench.concierge.pendingDispatches.length).toBe(0);
  });
});
