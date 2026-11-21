import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { App } from "../dist/src/app.js";
import { loadConfig } from "../dist/src/config.js";
import { inspectInboundRedLines } from "../dist/src/sugent/concierge-guardrails.js";

// 启动前硬门禁：确认“怎么收费”100% 触发入站红线挂起
const selfCheck = inspectInboundRedLines(
  "冬辰总您好，想咨询一下贵司工业AI与BOM流程诊断大概怎么收费、下月有档期吗？",
  false,
);
assert.equal(selfCheck.requiresSuspendApproval, true, "红线自检失败：怎么收费未触发挂起！");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-ceo-demo-"));
let appRef = null;

const demoModels = {
  async listModels() {
    return [
      "deepseek/deepseek-chat",
      "deepseek/deepseek-reasoner",
      "anthropic/claude-sonnet-4-20250514",
      "ollama/qwen2.5:14b",
    ];
  },
  async streamChat(req, onDelta) {
    // 若本机 Ollama 正在运行则优先调用真模型，否则使用本地知识图谱生成流式回复
    try {
      const res = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(600) });
      if (res.ok) {
        const tags = await res.json();
        const firstOllama = tags?.models?.[0]?.name;
        if (firstOllama) {
          const chatRes = await fetch("http://127.0.0.1:11434/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: firstOllama, messages: req.messages, stream: false }),
            signal: req.signal,
          });
          if (chatRes.ok) {
            const data = await chatRes.json();
            const reply = data?.choices?.[0]?.message?.content || "";
            if (reply) {
              onDelta(reply);
              return reply;
            }
          }
        }
      }
    } catch {
      // 本机未开 Ollama，平滑走下方本地知识图谱演示应答
    }

    const lastUser = String(req.messages.at(-1)?.content ?? "");
    const kgSnap = appRef?.knowledgeGraph.recallSubgraph(lastUser, 2, 10);
    const wb = appRef?.conciergeBridge.getWorkbench();
    const text = [
      `【Sugent 离线图谱演练模式 · 当前路由模型：${req.model}】`,
      `已检索本机知识图谱（命中 ${kgSnap?.matchedNodes.length ?? 0} 个实体）与幕僚耳麦队列（待拍板 ${wb?.cards.length ?? 0} 张 / 冷静窗 ${wb?.pendingDispatches.length ?? 0} 条）：`,
      kgSnap?.markdown || "暂无匹配图谱实体",
      "",
      "提示：点击左下角【设置】图标，即可在首屏置顶的【幕僚耳麦工作台】中用鼠标点按测试代发、改稿二次确认与倒计时零痕迹撤回。",
    ].join("\n");
    for (const chunk of text.match(/.{1,18}/gs) ?? [text]) {
      onDelta(chunk);
      await new Promise((r) => setTimeout(r, 15));
    }
    return text;
  },
};

const app = new App(
  loadConfig({
    dataDir,
    env: {
      ...process.env,
      AMB_MAGPIE_BASE_URL: "http://127.0.0.1:43199/v1",
      AMB_UI_PORT: "3900",
      AMB_AGENT: "off",
    },
  }),
  { printQrToTerminal: false, models: demoModels },
);
appRef = app;

await app.start();

app.store.saveWeixinAccount({
  botId: "default",
  botToken: "tok-wx-ceo-demo",
  ilinkBotId: "ilink_ceo_demo",
  baseUrl: "http://127.0.0.1:9",
  ownerUserId: "wx_owner_andy",
});

app.knowledgeGraph.applyDelta({
  nodes: [
    {
      id: "peer:wx_vip_zhang",
      kind: "person",
      name: "张总（华东精益数智化 VIP）",
      summary: "二期 LDC 精益云签约客户，偏好周三下午线上评审多视图 BOM 方案",
      tags: ["peer:wx_vip_zhang", "vip"],
      reinforcements: 4,
    },
    {
      id: "peer:wx_secret_li",
      kind: "person",
      name: "李行长（保密商务谈判）",
      summary: "私有化底座特批底价 CANARY_FLOOR_480K 仅限内部决策参考",
      tags: ["peer:wx_secret_li", "confidential"],
      reinforcements: 2,
    },
    {
      id: "catalog:lean-ai-diagnostic",
      kind: "project",
      name: "工业 AI 与 ECN 流程诊断标准包",
      summary: "2 周标准交付周期，涵盖多视图 BOM 贯通与智能体协同评估",
      tags: ["public_catalog", "offering"],
      reinforcements: 5,
    },
    {
      id: "wf:diagnostic-kickoff",
      kind: "workflow",
      name: "客户诊断排期标准 SOP",
      summary: "发送诊断准备清单并锁定 30 分钟线上评审会议",
      tags: ["public_catalog", "sop"],
      reinforcements: 3,
      steps: ["核对企业 BOM 与 ECN 痛点", "发送标准准备清单", "锁定周三下午 30 分钟线上评审"],
    },
  ],
  edges: [
    { from: "peer:wx_vip_zhang", relation: "subscribed_to", to: "catalog:lean-ai-diagnostic", source: "ceo_demo" },
    { from: "catalog:lean-ai-diagnostic", relation: "follows_sop", to: "wf:diagnostic-kickoff", source: "ceo_demo" },
  ],
});

await app.upsertDecoupledProvider({
  id: "deepseek",
  name: "DeepSeek 官方直连（守门与管家）",
  preset: "deepseek",
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "tok-demo-ds-8801",
  models: ["deepseek-chat", "deepseek-reasoner"],
  defaultModel: "deepseek-chat",
  setDefault: false,
});
await app.upsertDecoupledProvider({
  id: "anthropic",
  name: "Anthropic Claude（主力攻坚）",
  preset: "anthropic",
  baseUrl: "https://api.anthropic.com/v1",
  apiKey: "tok-demo-ant-9902",
  models: ["claude-sonnet-4-20250514"],
  defaultModel: "claude-sonnet-4-20250514",
  setDefault: true,
});
await app.upsertDecoupledProvider({
  id: "ollama",
  name: "本机 Ollama（离线免密）",
  preset: "ollama",
  baseUrl: "http://127.0.0.1:11434/v1",
  models: ["qwen2.5:14b"],
  defaultModel: "qwen2.5:14b",
  setDefault: false,
});
await app.updateProviderRouting({
  assessor: "deepseek/deepseek-chat",
  executor: "anthropic/claude-sonnet-4-20250514",
  computerUse: "anthropic/claude-sonnet-4-20250514",
  steward: "deepseek/deepseek-chat",
});
await app.setBotBudget("default", { enabled: true, limitUsd: 50 });
app.recordLocalBotUsageCost("default", 11.8);

app.conciergeBridge.updateConfig({
  enabled: true,
  ownerDisplayName: "冬辰",
  cloudMode: "byok_local",
  coolingWindowMs: 45000,
  explicitAssistantWhitelistPeerIds: ["wx_vip_zhang"],
});
app.conciergeBridge.setTransportOverride({
  notifyOwner: async (ch, text) => {
    app.notice("info", `[耳麦推送·${ch}] ${text.split("\n")[0]}`);
    console.log(`\n=== 🎧 主理人私密耳麦 (${ch}) ===\n${text}\n`);
  },
  sendPeerDirectMessage: async (ch, peerId, text) => {
    app.notice("info", `[明牌外发·${ch}:${peerId}] ${text}`);
    console.log(`\n=== 📤 实际外发至客户 (${ch} -> ${peerId}) ===\n${text}\n`);
  },
});

const strangerOut = await app.conciergeBridge.processInboundEvent({
  id: "demo_stranger_01",
  channel: "weixin",
  botId: "default",
  account: "default",
  conversation: { kind: "dm", id: "wx_stranger_wang" },
  sender: { id: "wx_stranger_wang", name: "王总（新来访制造企业）" },
  parts: [{ type: "text", text: "冬辰总您好，想咨询一下贵司工业AI与BOM流程诊断大概怎么收费、下月有档期吗？" }],
  replyHandle: {},
  receivedAt: Date.now(),
});
assert.equal(strangerOut.routeTaken, "suspended_for_owner_approval", "王总询价必须挂起待批");

await app.conciergeBridge.processInboundEvent({
  id: "demo_group_01",
  channel: "feishu",
  botId: "default",
  account: "default",
  conversation: { kind: "group", id: "oc_lean_group" },
  sender: { id: "ou_song_dir", name: "宋部长" },
  parts: [{ type: "text", text: "各位，下周三下午的二期精益数智化评审议程确定了吗？" }],
  replyHandle: {},
  receivedAt: Date.now(),
});

await app.conciergeBridge.processInboundEvent({
  id: "demo_vip_01",
  channel: "weixin",
  botId: "default",
  account: "default",
  conversation: { kind: "dm", id: "wx_vip_zhang" },
  sender: { id: "wx_vip_zhang", name: "张总（华东精益数智化 VIP）" },
  parts: [{ type: "text", text: "请问下周三下午能预约个线上会议对齐二期流程方案吗？" }],
  replyHandle: {},
  receivedAt: Date.now(),
});

const cjkRecall = app.knowledgeGraph.recallSubgraph("张总二期是什么情况", 2);
assert.ok(cjkRecall.matchedNodes.length >= 3, "中文无空格图谱多跳召回断言失败");
console.log("==================================================");
console.log("✅ Sugent CEO 可视化验收工作台已启动:", app.web.url);
console.log("🛡️ 红线硬断言已通过: 王总『怎么收费』-> suspended_for_owner_approval");
console.log("👉 主屏直达: 浏览器打开后无需进设置，直接看主界面正上方【倒计时撤回悬浮舱】与右上角【🎧 幕僚耳麦】抽屉按钮 (快捷键 ⌘E)！");
console.log("==================================================\n");

execFile("open", [app.web.url]);
process.on("SIGINT", async () => {
  await app.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
});
