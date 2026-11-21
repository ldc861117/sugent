import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { App } from "../dist/src/app.js";
import { loadConfig } from "../dist/src/config.js";

function loadDotEnv(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const localEnv = { ...process.env, ...loadDotEnv(path.join(process.cwd(), ".env")) };
const gatewayUrl = localEnv.SUGENT_GATEWAY_URL || localEnv.AMB_MAGPIE_BASE_URL || "";
const gatewayKey = localEnv.SUGENT_GATEWAY_KEY || localEnv.AMB_MAGPIE_API_KEY || "";
const stewardModel = localEnv.SUGENT_MODEL_STEWARD || localEnv.AMB_DEFAULT_MODEL || "";
const liveGatewayEnabled = Boolean(gatewayUrl && gatewayKey);

const ephemeral = localEnv.SUGENT_WORKBENCH_EPHEMERAL === "1";
const dataDir = ephemeral
  ? fs.mkdtempSync(path.join(os.tmpdir(), "sugent-jarvis-workbench-"))
  : path.resolve(localEnv.SUGENT_WORKBENCH_DATA_DIR || path.join(process.cwd(), "data", "jarvis-workbench"));
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
let appRef = null;

const demoModels = {
  async listModels() {
    if (stewardModel) return [stewardModel, "gemini-4-hydrogen-xhigh"];
    return [
      "deepseek/deepseek-chat",
      "anthropic/claude-sonnet-4-20250514",
      "ollama/qwen2.5:14b",
    ];
  },
  async streamChat(req, onDelta) {
    const lastUser = String(req.messages.at(-1)?.content ?? "").trim();
    if (!lastUser) return "";
    const history = req.messages
      .slice(0, -1)
      .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m) => ({ role: m.role, content: m.content }));
    const res = await appRef.stewardService.converse({
      text: lastUser,
      channel: "web_ui",
      callerDomain: "owner_private",
      history,
    });
    const text = res.reply;
    for (const chunk of text.match(/.{1,24}/gs) ?? [text]) {
      onDelta(chunk);
      await new Promise((r) => setTimeout(r, 10));
    }
    return text;
  },
};

const app = new App(
  loadConfig({
    dataDir,
    env: {
      ...localEnv,
      AMB_MAGPIE_BASE_URL: gatewayUrl || "http://127.0.0.1:43199/v1",
      AMB_MAGPIE_API_KEY: gatewayKey,
      ...(stewardModel ? { AMB_DEFAULT_MODEL: stewardModel } : {}),
      AMB_UI_PORT: localEnv.SUGENT_WORKBENCH_PORT || "3900",
      AMB_AGENT: "off",
    },
  }),
  { printQrToTerminal: false, models: demoModels },
);
appRef = app;

await app.start();

app.store.saveWeixinAccount({
  botId: "default",
  botToken: "tok-wx-jarvis-demo",
  ilinkBotId: "ilink_jarvis_demo",
  baseUrl: "http://127.0.0.1:9",
  ownerUserId: "wx_owner_andy",
});

if (liveGatewayEnabled) {
  const m = stewardModel || "gemini-4-neon-xhigh";
  await app.upsertDecoupledProvider({
    id: "custom-gateway",
    name: "CLIProxyAPI 云端推理网关",
    preset: "custom-openai",
    baseUrl: gatewayUrl,
    apiKey: gatewayKey,
    models: [m, "gemini-4-hydrogen-xhigh"],
    defaultModel: m,
    setDefault: true,
  });
  await app.updateProviderRouting({
    assessor: localEnv.SUGENT_MODEL_ASSESSOR || m,
    steward: m,
    executor: localEnv.SUGENT_MODEL_EXECUTOR || m,
    computerUse: localEnv.SUGENT_MODEL_COMPUTER_USE || m,
  });
} else {
  await app.upsertDecoupledProvider({
    id: "deepseek",
    name: "DeepSeek 官方直连（离线演示预设）",
    preset: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "tok-demo-ds-8801",
    models: ["deepseek-chat"],
    defaultModel: "deepseek-chat",
    setDefault: true,
  });
}
await app.setBotBudget("default", { enabled: true, limitUsd: 50 });
app.recordLocalBotUsageCost("default", 11.8);

const ledger = app.stewardService.ledger;
const now = Date.now();
const isoDays = (deltaDays) => new Date(now + deltaDays * 86_400_000).toISOString();

if (ledger.snapshotForCaller("owner_private").goals.length === 0) {
ledger.upsertRelationship({
  id: "owner-trust",
  partition: "personal_life",
  subjectType: "owner_trust",
  name: "主理人信任阶梯",
  roleTag: "owner",
  trustTier: "L1_whisper_prompt",
  verifiedObservations: 2,
});
ledger.upsertRelationship({
  id: "client-zhang",
  partition: "work_project",
  subjectType: "key_contact",
  name: "张总（制造业 VIP 客户）",
  roleTag: "client",
  taboos: ["忌直接发送低于八折的报价", "忌晚 9 点后推送消息"],
  preferences: ["偏好周三下午线上评审"],
  openFavors: ["上次协助引荐过华东设备厂商"],
});

ledger.upsertGoal(
  {
    id: "goal-jarvis-core",
    partition: "work_project",
    title: "打造贴身贾维斯私人幕僚",
    northStarCriterion: "Sprint 1–4 闭环交付且零命令日常可用",
    stallThresholdDays: 7,
    lastProgressAt: isoDays(-1),
  },
  { makePrimaryInPartition: true, nowIso: new Date(now).toISOString() },
);
ledger.upsertGoal({
  id: "goal-health",
  partition: "personal_life",
  title: "父母健康与家庭保障",
  northStarCriterion: "本月办妥异地就医备案与年度体检预约",
  stallThresholdDays: 5,
  lastProgressAt: isoDays(-8),
});
ledger.upsertGoal({
  id: "goal-client-q4",
  partition: "work_project",
  title: "Q4 制造业标杆客户二期签约",
  northStarCriterion: "本季度完成张总与华东标杆二期合同签署",
  stallThresholdDays: 7,
  lastProgressAt: isoDays(-2),
});

ledger.addGuardrail({
  id: "tomb-discount",
  partition: "work_project",
  kind: "tombstone",
  statement: "外发报价禁止低于八折，七折接单曾导致交付利润倒挂",
  evidenceSource: "2026-Q3 交付复盘",
});
ledger.upsertResource({
  id: "res-id-card",
  partition: "personal_life",
  kind: "personal_archive",
  title: "身份证与户口本扫描件（个人与父母证件备份）",
  localUriOrPath: "/Users/owner/Vault/identity/id-cards-2026.pdf",
  expiresAt: isoDays(20),
  metadata: { category: "identity", owner: "family" },
});
ledger.upsertResource({
  id: "res-passport",
  partition: "personal_life",
  kind: "personal_archive",
  title: "护照扫描件（因私出境）",
  localUriOrPath: "/Users/owner/Vault/identity/passport-2026.pdf",
  expiresAt: isoDays(320),
  metadata: { category: "passport" },
});
ledger.upsertCommitment({
  id: "commit-zhang-quote",
  partition: "work_project",
  direction: "i_owe",
  summary: "周五前向张总确认二期流程诊断排期",
  counterpartyOrRef: "client-zhang",
  dueAt: isoDays(1),
  remindLeadDays: 3,
});
ledger.upsertCommitment({
  id: "commit-partner-doc",
  partition: "work_project",
  direction: "waiting_for",
  summary: "等合作方回传盖章后的保密协议扫描件",
  counterpartyOrRef: "合作方法务",
  dueAt: isoDays(2),
});

app.conciergeBridge.updateConfig({
  enabled: true,
  ownerDisplayName: "冬辰",
  cloudMode: "byok_local",
  coolingWindowMs: 45000,
  explicitAssistantWhitelistPeerIds: ["wx_vip_zhang"],
});
await app.conciergeBridge.processInboundEvent({
  id: "demo_stranger_01",
  channel: "weixin",
  botId: "default",
  account: "default",
  conversation: { kind: "dm", id: "wx_stranger_wang" },
  sender: { id: "wx_stranger_wang", name: "王总（新来访客户）" },
  parts: [{ type: "text", text: "您好，想咨询一下贵司工业 AI 诊断怎么收费？" }],
  replyHandle: {},
  receivedAt: Date.now(),
});
}

const wbInfo = app.stewardService.getWorkbench("owner_private");
console.log("==================================================");
console.log("✅ Sugent 自然语言个人管家工作台已启动:", app.web.url);
console.log(`📂 数据目录: ${dataDir}${ephemeral ? " (临时)" : " (持久化)"}`);
console.log(`🧠 对话引擎: ${wbInfo.llmLive ? `实连模型 (${wbInfo.activeModel})` : "离线规则兜底"}`);
console.log("👉 主界面聊天框全程自然语言驱动，右上角仅保留单页【📋 看板 (⌘J)】用于总览与快速勾选");
console.log("==================================================");

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await app.stop();
    if (ephemeral) fs.rmSync(dataDir, { recursive: true, force: true });
    process.exit(0);
  });
}