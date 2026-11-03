#!/usr/bin/env node
/**
 * Sugent 零依赖核心契约自检脚本 (scripts/verify-sugent.mjs)
 * 使用 Node.js 原生 node:assert/strict 验证编译后的 dist/src/sugent/ 模块，
 * 确保在任何沙箱或 CI 环境下都能秒级完成端到端回归验证。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_ROLE_ROUTING,
  PersonalSourceRegistry,
  SugentKnowledgeGraph,
  assessSelfEditPath,
  buildMagpieEnvOverrides,
  buildSelfEvolutionPlan,
  buildSelfEvolutionPromptSection,
  discoverLocalSourceRepo,
  ensureSelfEvolutionOverlay,
  evaluatePersonalTrigger,
  installSelfDevSkill,
  listSelfEvolutionPlugins,
  parseKGDelta,
  prepareSelfEvolutionWorkspace,
  resetSelfEvolutionOverlay,
  resolveOverlayUiFile,
  resolveSelfEvolutionRoot,
  resolveSugentGatewayConfig,
  selectModelForRole,
  shouldSuggestRulePromotion,
} from "../dist/src/sugent/index.js";
import { normalizeSettings } from "../dist/src/agent/settings.js";

// 1. 默认网关模式与角色路由验证
{
  const cfg = resolveSugentGatewayConfig(undefined, {});
  assert.equal(cfg.mode, "modelflare");
  assert.equal(cfg.unlockSubscriptions, false);
  assert.equal(cfg.routing.assessor, DEFAULT_ROLE_ROUTING.assessor);
  assert.equal(buildMagpieEnvOverrides(cfg).MAGPIE_NO_ACCOUNTS, "1");
}

// 2. 外部网关解耦与本地订阅解锁验证
{
  const cfg = resolveSugentGatewayConfig(undefined, {
    SUGENT_GATEWAY_URL: "http://127.0.0.1:3425/v1",
    SUGENT_GATEWAY_KEY: "sk-local-magpie",
    SUGENT_UNLOCK_SUBSCRIPTIONS: "1",
    SUGENT_PRIVACY_MASKING: "1",
    SUGENT_MODEL_ASSESSOR: "deepseek/deepseek-chat",
    SUGENT_MODEL_EXECUTOR: "anthropic/claude-opus-4-6",
  });
  assert.equal(cfg.mode, "external");
  assert.equal(cfg.unlockSubscriptions, true);
  assert.equal(cfg.privacyMasking, true);
  assert.equal(buildMagpieEnvOverrides(cfg).MAGPIE_NO_ACCOUNTS, undefined);
  assert.equal(selectModelForRole(cfg, "assessor"), "deepseek/deepseek-chat");
  assert.equal(selectModelForRole(cfg, "executor"), "anthropic/claude-opus-4-6");
}

// 3. PersonalSourceRegistry 与 Intake -> Eval -> Ticket 门控验证
{
  const registry = new PersonalSourceRegistry();
  assert.equal(registry.listKinds().length, 3);

  const strangerTrigger = registry.ingest(
    "im_channel",
    "wx-default",
    {
      messageId: "m-stranger",
      channel: "weixin",
      conversationId: "c-1",
      senderId: "stranger-id",
      text: "hello",
    },
    ["owner-id"],
  );
  const strangerDecision = evaluatePersonalTrigger(strangerTrigger);
  assert.equal(strangerDecision.outcome, "ignore_noise");
  assert.equal(strangerDecision.reasonCode, "unlisted_sender");

  const ownerTrigger = registry.ingest(
    "im_channel",
    "wx-default",
    {
      messageId: "m-owner",
      channel: "weixin",
      conversationId: "c-owner",
      senderId: "owner-id",
      text: "帮我打开浏览器整理桌面账单",
    },
    ["owner-id"],
  );
  const actDecision = evaluatePersonalTrigger(ownerTrigger, { requiresComputerUse: true });
  assert.equal(actDecision.outcome, "accept_act");
  assert.equal(actDecision.recommendedRole, "computer_use");

  const followupDecision = evaluatePersonalTrigger(ownerTrigger, { activeTicketIdForThread: "ticket-100" });
  assert.equal(followupDecision.outcome, "attach_ticket");
  assert.equal(followupDecision.targetTicketId, "ticket-100");

  const ghTrigger = registry.ingest(
    "github",
    "gh-sugent",
    {
      id: "ev-1",
      repo: "ldc861117/sugent",
      issueOrPrNumber: 1,
      senderLogin: "ldc861117",
      body: "upstream updated",
      mentionedAgent: false,
    },
    ["ldc861117"],
  );
  const ruleObserve = {
    id: "r-upstream",
    title: "每日同步双上游",
    sourceKind: "github",
    mode: "observe",
    verifiedObservations: 2,
    suggestPromoteAfter: 3,
  };
  const obsDecision = evaluatePersonalTrigger(ghTrigger, { matchingRules: [ruleObserve] });
  assert.equal(obsDecision.outcome, "accept_observe");
  assert.equal(shouldSuggestRulePromotion(ruleObserve), false);
  assert.equal(shouldSuggestRulePromotion({ ...ruleObserve, verifiedObservations: 3 }), true);
}

// 4. 自主知识图谱、标准化一键自我迭代开关与打包态 OverlayFS 热覆盖验证
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-kg-verify-"));
  try {
    const kg = new SugentKnowledgeGraph(tmpDir);
    kg.applyDelta(
      {
        nodes: [
          { id: "user:owner", kind: "person", name: "Owner", summary: "Sugent 架构师", tags: ["owner"] },
          { id: "proj:sugent", kind: "project", name: "Sugent", summary: "全能个人 Agent", tags: ["agent"] },
          { id: "model:old", kind: "tool", name: "Old Model", summary: "旧默认模型", tags: ["llm"] },
          { id: "model:new", kind: "tool", name: "New Model", summary: "新主力模型", tags: ["llm"] },
          {
            id: "wf:sync",
            kind: "workflow",
            name: "双上游同步 SOP",
            summary: "每日自动巡检并合并上游变更",
            tags: ["sop"],
            reinforcements: 3,
            steps: ["npm run sync:upstreams", "npm run verify:sugent"],
          },
        ],
        edges: [
          { from: "user:owner", relation: "owns", to: "proj:sugent", source: "init" },
          { from: "proj:sugent", relation: "uses_model", to: "model:old", source: "t1", exclusive: true },
          { from: "proj:sugent", relation: "has_sop", to: "wf:sync", source: "t1" },
        ],
      },
      "2026-11-01T10:00:00.000Z",
    );

    kg.applyDelta(
      {
        edges: [{ from: "proj:sugent", relation: "uses_model", to: "model:new", source: "t2", exclusive: true }],
      },
      "2026-11-01T11:00:00.000Z",
    );

    const sub = kg.recallSubgraph("Owner", 2);
    const ids = sub.matchedNodes.map((n) => n.id);
    assert.ok(ids.includes("user:owner"));
    assert.ok(ids.includes("proj:sugent"));
    assert.ok(ids.includes("model:new"));
    assert.ok(ids.includes("wf:sync"));
    assert.ok(!ids.includes("model:old"));

    const syncRes = kg.ingestMemoryReviewOps(
      { add: [{ text: "发布流程：先运行 npm run verify:sugent；再执行 git push", topic: "devops" }], remove: [] },
      "bot:default",
    );
    assert.ok(syncRes.upsertedNodes >= 2);

    const parsedDelta = parseKGDelta(
      '{"nodes":[{"id":"tool:magpie","kind":"tool","name":"Magpie","summary":"本地模型网关"}],"edges":[{"from":"proj:sugent","relation":"uses_gateway","to":"tool:magpie","source":"steward","exclusive":true}]}',
    );
    assert.equal(parsedDelta.nodes?.length, 1);
    assert.equal(parsedDelta.edges?.length, 1);

    const skillsDir = path.join(tmpDir, "skills");
    const writtenFiles = kg.crystallizeSkillsToDir(skillsDir, 3);
    assert.equal(writtenFiles.length, 1);
    assert.ok(fs.existsSync(writtenFiles[0]));

    // 5. 自我迭代围栏、BotSettings.selfEvolution 开关与打包态 OverlayFS 热演进验证
    assert.equal(assessSelfEditPath("src/sugent/new-feature.ts").risk, "autonomous");
    assert.equal(assessSelfEditPath("plugins/my-hook.mjs").risk, "autonomous");
    assert.equal(assessSelfEditPath("electron/main.ts").risk, "requires_approval");
    assert.equal(assessSelfEditPath(".git/config").risk, "forbidden");

    const defaultBotSettings = normalizeSettings({});
    assert.equal(defaultBotSettings.selfEvolution.enabled, false);
    const enabledBotSettings = normalizeSettings({ selfEvolution: { enabled: true } });
    assert.equal(enabledBotSettings.selfEvolution.enabled, true);

    const resolvedRoot = resolveSelfEvolutionRoot(tmpDir);
    assert.ok(fs.existsSync(path.join(resolvedRoot, "package.json")));

    // 模拟打包态 (app.asar) 下自动回退到 <dataDir>/self-repo 热覆盖层，并验证核心代码镜像、文档与提示词强感知
    const packagedRoot = resolveSelfEvolutionRoot(tmpDir, "/Applications/Sugent.app/Contents/Resources/app.asar");
    assert.equal(packagedRoot, path.join(tmpDir, "self-repo"));
    assert.ok(fs.existsSync(path.join(packagedRoot, "README_SELF_EVOLUTION.md")));
    assert.ok(fs.existsSync(path.join(packagedRoot, "src", "sugent", "self-evolution.ts")));
    assert.ok(fs.existsSync(path.join(packagedRoot, "ui", "main.js")));

    const fullPrompt = buildSelfEvolutionPromptSection(resolvedRoot);
    assert.ok(fullPrompt.includes("Self-Evolution Mode 已开启"));
    assert.ok(fullPrompt.includes(resolvedRoot));
    assert.ok(fullPrompt.includes("Full-Source Git Mode"));

    const overlayPrompt = buildSelfEvolutionPromptSection(packagedRoot);
    assert.ok(overlayPrompt.includes("Hot-Overlay Mode"));
    assert.ok(overlayPrompt.includes(packagedRoot));
    assert.ok(discoverLocalSourceRepo()?.endsWith("sugent"));

    // 验证 UI Copy-on-Write 热覆盖与回退
    const builtinUi = path.join(resolvedRoot, "ui");
    assert.equal(resolveOverlayUiFile(tmpDir, builtinUi, "main.js"), path.join(builtinUi, "main.js"));
    const customMain = path.join(packagedRoot, "ui", "main.js");
    fs.writeFileSync(customMain, "// evolved by sugent\n");
    assert.equal(resolveOverlayUiFile(tmpDir, builtinUi, "main.js"), customMain);

    // 验证自定义运行时插件 (.mjs) 发现与一键安全重置 (resetSelfEvolutionOverlay)
    fs.writeFileSync(path.join(packagedRoot, "plugins", "auto-tagger.mjs"), "export default {}\n");
    const extPlugins = listSelfEvolutionPlugins(tmpDir);
    assert.equal(extPlugins.length, 1);
    assert.equal(extPlugins[0].id, "sugent-ext-auto-tagger");

    const resetRes = resetSelfEvolutionOverlay(tmpDir);
    assert.ok(resetRes.archivedTo && fs.existsSync(resetRes.archivedTo));
    assert.equal(resolveOverlayUiFile(tmpDir, builtinUi, "main.js"), path.join(builtinUi, "main.js"));

    const dshHome = path.join(tmpDir, "dsh-bot1");
    const prepared = prepareSelfEvolutionWorkspace(tmpDir, dshHome);
    assert.equal(prepared.workspaceRoot, resolvedRoot);
    assert.ok(fs.existsSync(prepared.skillFile));

    const plan = buildSelfEvolutionPlan("Add mail source", "31ef67c", ["src/sugent/sources.ts", "test/sugent-sources.unit.test.ts"]);
    assert.equal(plan.overallRisk, "autonomous");

    const selfDevSkillPath = installSelfDevSkill(skillsDir);
    assert.ok(fs.existsSync(selfDevSkillPath));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

console.log(
  "verify:sugent — 全部核心契约断言通过 (Gateway 解耦 / 四角色路由 / 状态机 / 知识图谱 / 双模自我迭代与打包态 OverlayFS 热演进)",
);
