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
import { DatabaseSync } from "node:sqlite";
import {
  CausalLedger,
  CoworkHitlClient,
  CoworkPermissionError,
  DEFAULT_MAX_HOPS,
  DEFAULT_ROLE_ROUTING,
  DeliverySecurityError,
  GOOGLE_OIDC_ISSUER,
  LocalBudgetLedger,
  MAX_ACTIVE_GOALS,
  PersonalSourceRegistry,
  ProviderRegistry,
  SecurityEnvelopeError,
  StewardshipLedger,
  StewardshipLedgerError,
  SugentAuthManager,
  SugentKnowledgeGraph,
  SugentModelCatalog,
  SuspendedRoundStore,
  UniversalDropzone,
  ZeroTokenProbeTracker,
  assertMainBranchConfigSource,
  assessSelfEditPath,
  buildCoworkMcpPatchLines,
  buildMagpieEnvOverrides,
  buildSelfEvolutionPlan,
  buildSelfEvolutionPromptSection,
  createEnvelopedRuleEventSink,
  deriveChildTriggerHop,
  discoverLocalSourceRepo,
  evaluateDeliveryNextStep,
  evaluatePersonalTrigger,
  guardPrivilegedEventFields,
  ingestCoworkPendingEvent,
  installDeliverySkill,
  installSelfDevSkill,
  listSelfEvolutionPlugins,
  parseAgentReceipt,
  parseCoworkFederationProfile,
  parseKGDelta,
  parseTrustedDeliveryPolicy,
  prepareSelfEvolutionWorkspace,
  resetHopChainByOwner,
  resetSelfEvolutionOverlay,
  resolveGeminiWeb2ApiUrls,
  resolveOverlayUiFile,
  resolveSelfEvolutionRoot,
  ConciergeChannelBridge,
  buildBrokerDesktopAuthConfig,
  deriveSyncKeyHierarchy,
  openZeroKnowledgeEnvelope,
  resolveSugentGatewayConfig,
  sealExternalEvent,
  sealZeroKnowledgeEnvelope,
  selectModelForRole,
  shouldSuggestRulePromotion,
  simulateMonthlyRoleCosts,
  AntigravityHookSink,
  AntigravityStateReader,
  FleetPulseReader,
  ProjectPrivacyRegistry,
  canonicalizeProjectKey,
  createAttentionBudgetGate,
  filterSupersededBeforeSend,
  scanLedgerImbalances,
  stageSugentStewardPluginHooks,
  ArtifactComprehensionPipeline,
  AntigravityDispatcher,
  LocalDiffCanonPublisher,
  SugentStewardMcpServer,
  stageSugentStewardPluginMcp,
  RepoBindingRegistry,
  HandoffFileBridge,
  SafeRelaunchCoordinator,
  VibeCodingPipelineOrchestrator,
  CodingHarnessRegistry,
  AntigravityCodingHarness,
  writeBootHealthyStamp,
  readBootHealthyStamp,
  CapabilityAwarenessEngine,
  AuthorizedFileReader,
  STEWARD_CAPABILITY_DESCRIPTORS,
  SugentAvatarStudio,
  rigAvatarImageBuffer,
  rigPoseSheetImageBuffer,
  POSE_KEYS,
  decodePngToRgba,
  CANONICAL_VISOR_RIG_V1,
  SugentSIMStore,
  computeEventDelta,
  scoreEventSalience,
  evaluateClarificationAndFocus,
  evaluateFlowAwareDelivery,
  evaluateExecutionBudgetGate,
  updateToolReliabilityEma,
  quarantineSelfEvolutionArtifact,
  listQuarantinedArtifacts,
  runGardenerCycle,
  ModelPoolSyncer,
  RoutingExperienceStore,
  AdaptiveModelRouter,
  HotBundleSlotManager,
  HotReloadBus,
  HotCoreSupervisor,
  generateHotBundleKeyPair,
  createSignedHotBundle,
  verifyHotBundleArchive,
  hasVerifiedActiveOrPendingSlot,
  OwnerChannelStewardRouter,
  resolveUnifiedCausalLedgerDir,
  OpsBridgeClient,
  evaluateWeixinSingleHolderGuard,
  pruneProjectPulseForTier,
  resolveOpsBridgeConfig,
  AcpCodingHarness,
  DualTrackCodingBudget,
  GitRefCheckpointManager,
  LazyDesktopPermissionGate,
  allocateWorktreeIsolationEnv,
  buildSafeAcpCliArgv,
  completeColdStartApprovalDemo,
  ingestColdStartDrop,
  inspectWorkspaceFsTopology,
  probeColdStartReadiness,
  stagePrReviewToHandoff,
  PowerSaveBlockerController,
  E2eeOfflineDigestVault,
  buildOfflineLedgerDigest,
  COMPLIANCE_MODE,
  WeixinAdaptiveQuotaGuard,
  buildThreeSecondForwardedBriefing,
  BUILTIN_WEAPON_PACKAGES,
  WeaponSoakTelemetryLedger,
  listWeaponPackages,
  runContractQuoteGuardPack,
  runIndustrialFdeDiagnosticPack,
  SugentStewardHostService,
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
  assert.equal(registry.listKinds().length, 4);
  assert.ok(registry.listKinds().some((item) => item.kind === "antigravity"));

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

    // 模拟打包态 (app.asar) 下绑定到仅含 extensions/plugins 与 extensions/skills 的可写扩展目录
    const packagedRoot = resolveSelfEvolutionRoot(tmpDir, "/Applications/Sugent.app/Contents/Resources/app.asar");
    assert.equal(packagedRoot, path.join(tmpDir, "self-repo", "extensions"));
    assert.ok(fs.existsSync(path.join(tmpDir, "self-repo", "README_SELF_EVOLUTION.md")));
    assert.ok(fs.existsSync(path.join(tmpDir, "self-repo", "src", "sugent", "self-evolution.ts")));
    assert.equal(fs.existsSync(path.join(packagedRoot, "ui")), false);

    const fullPrompt = buildSelfEvolutionPromptSection(resolvedRoot);
    assert.ok(fullPrompt.includes("Self-Evolution Mode 已开启"));
    assert.ok(fullPrompt.includes(resolvedRoot));
    assert.ok(fullPrompt.includes("Full-Source Git Mode"));

    const overlayPrompt = buildSelfEvolutionPromptSection(packagedRoot);
    assert.ok(overlayPrompt.includes("Skills + Plugins Mode"));
    assert.ok(overlayPrompt.includes(packagedRoot));
    assert.ok(discoverLocalSourceRepo()?.endsWith("sugent"));

    // 验证打包版始终使用官方 UI，即使扩展 workspace 中出现 ui 文件也不加载
    const builtinUi = path.join(resolvedRoot, "ui");
    assert.equal(resolveOverlayUiFile(tmpDir, builtinUi, "main.js"), path.join(builtinUi, "main.js"));
    const customMain = path.join(packagedRoot, "ui", "main.js");
    fs.mkdirSync(path.dirname(customMain), { recursive: true });
    fs.writeFileSync(customMain, "// evolved by sugent\n");
    assert.equal(resolveOverlayUiFile(tmpDir, builtinUi, "main.js"), path.join(builtinUi, "main.js"));

    // 验证自定义运行时插件 (.mjs) 发现与一键安全重置 (resetSelfEvolutionOverlay)
    fs.writeFileSync(path.join(packagedRoot, "plugins", "auto-tagger.mjs"), "export default {}\n");
    fs.writeFileSync(path.join(packagedRoot, "plugins", "auto-tagger.json"), JSON.stringify({ id: "sugent-ext-auto-tagger", apiVersion: 1 }));
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

    // 6. M1.4 指令数据物理分离与越权字段拦截验证
    const secWs = path.join(tmpDir, "sec-workspace");
    assert.throws(
      () => guardPrivilegedEventFields({ id: "42", cwd: "./override", permission: "workspace-write" }),
      (err) => err instanceof SecurityEnvelopeError && err.code === "privileged_field_violation",
    );
    const stripped = guardPrivilegedEventFields(
      { id: "42", agent: "codex", access: "full", body: "untrusted" },
      { mode: "strip" },
    );
    assert.deepEqual(stripped.strippedFields, ["agent", "access"]);
    assert.equal("agent" in stripped.sanitized, false);

    const sealed = sealExternalEvent({
      workspaceDir: secWs,
      source: "github",
      eventType: "issues.opened",
      eventId: "42",
      ref: "ldc861117/sugent#42",
      url: "https://github.com/ldc861117/sugent",
      title: "RAW_EXTERNAL_TITLE_SAMPLE",
      body: "RAW_EXTERNAL_BODY_SAMPLE",
      payload: { id: "42", title: "RAW_EXTERNAL_TITLE_SAMPLE", body: "RAW_EXTERNAL_BODY_SAMPLE" },
    });
    assert.equal(sealed.envelope.contextFile, ".context/event-42.md");
    assert.equal(sealed.prompt.includes("RAW_EXTERNAL_TITLE_SAMPLE"), false);
    assert.equal(sealed.prompt.includes("RAW_EXTERNAL_BODY_SAMPLE"), false);
    assert.equal(fs.statSync(sealed.envelope.absoluteFilePath).mode & 0o777, 0o400);
    assert.ok(fs.readFileSync(sealed.envelope.absoluteFilePath, "utf8").includes("RAW_EXTERNAL_BODY_SAMPLE"));

    const sinkCaptured = [];
    const wrappedSink = createEnvelopedRuleEventSink(
      { emitRuleEvent: (_src, ev) => (sinkCaptured.push(ev), ["rl_1"]) },
      { resolveWorkspaceDir: () => secWs },
    );
    assert.deepEqual(
      wrappedSink.emitRuleEvent("github", { id: "43", type: "issues.opened", body: "RAW_SINK_BODY_SAMPLE" }),
      ["rl_1"],
    );
    assert.equal(JSON.stringify(sinkCaptured[0]).includes("RAW_SINK_BODY_SAMPLE"), false);

    // 7. M2.1 8 跳级联熔断与 Append-Only 因果哈希账本验证
    assert.equal(DEFAULT_MAX_HOPS, 8);
    let chainedTrigger = {
      id: "tr-root",
      sourceKind: "github",
      sourceInstanceId: "gh-1",
      threadKey: "th-1",
      senderId: "owner",
      addressedToAgent: true,
      fromAllowedSender: true,
      text: "root event",
      createdAt: "2026-11-11T00:00:00.000Z",
    };
    for (let i = 1; i <= 9; i++) {
      const nextHop = deriveChildTriggerHop(chainedTrigger);
      chainedTrigger = { ...chainedTrigger, id: `tr-hop-${i}`, ...nextHop };
    }
    const haltedDecision = evaluatePersonalTrigger(chainedTrigger);
    assert.equal(haltedDecision.outcome, "halt_circuit_breaker");
    assert.equal(haltedDecision.requiresOwnerAlert, true);
    const resetTrigger = resetHopChainByOwner(chainedTrigger, "tr-owner-reset");
    assert.equal(evaluatePersonalTrigger(resetTrigger).outcome, "accept_act");

    const ledgerDir = path.join(tmpDir, "causal-ledger-dir");
    const ledger = new CausalLedger(ledgerDir);
    ledger.append({
      roundId: "rnd-1",
      kind: "round_triggered",
      at: "2026-11-11T09:00:00.000Z",
      title: "跨规则级联自检",
      ruleId: "rule-1",
      ruleVersion: 1,
      source: "github",
      hopCount: 9,
    });
    ledger.append({
      roundId: "rnd-1",
      kind: "circuit_broken",
      at: "2026-11-11T09:00:01.000Z",
      hopCount: 9,
      maxHops: DEFAULT_MAX_HOPS,
      summary: haltedDecision.reasonCode,
    });
    assert.equal(ledger.rebuildProjection().factCount, 2);
    assert.equal(ledger.traceRound("rnd-1")?.status, "circuit_broken");
    assert.ok(ledger.explainWhy("rnd-1").includes("跳数熔断"));

    // 8. Sugent × Cowork 动态联邦桥接器与双重 RBAC 审批门控验证
    const coworkUrl = ["http:", "", "127.0.0.1:28080"].join("/");
    const techCfg = parseCoworkFederationProfile({
      baseUrl: coworkUrl,
      workspaceId: "ws-verify",
      identity: { userId: "USR-TECH-01", role: "technician" },
      gateway: { apiKey: "emp-verify-tech" },
    });
    assert.equal(techCfg.canApproveHitl, false);
    assert.equal(buildCoworkMcpPatchLines(techCfg).join("\n").includes("emp-verify-tech"), false);
    const coworkTrigger = ingestCoworkPendingEvent(
      techCfg,
      { draft_id: "DFT-VERIFY-1", summary: "UNTRUSTED_DRAFT_SUMMARY" },
      { workspaceDir: secWs },
    );
    assert.equal(coworkTrigger.text.includes("UNTRUSTED_DRAFT_SUMMARY"), false);
    const techHitl = new CoworkHitlClient(techCfg, async () => ({ status: "APPROVED" }));
    await assert.rejects(() => techHitl.approveDraft("DFT-VERIFY-1"), CoworkPermissionError);

    // 9. M1.5 主干受信 PR 交付门禁、零 Token 探针与挂起零消耗回执验证
    assert.equal(assertMainBranchConfigSource("main"), "main");
    assert.throws(() => assertMainBranchConfigSource(["refs", "pull", "1", "head"].join("/")), DeliverySecurityError);
    const delivPolicy = parseTrustedDeliveryPolicy("main", { trustedMaintainers: ["ldc861117"] });
    assert.equal(
      evaluateDeliveryNextStep(delivPolicy, {
        mode: "deliver-review",
        prNumber: 1,
        authorLogin: "ldc861117",
        reviewedHeadSha: "aaaa1111",
        currentHeadSha: "aaaa1111",
        reviewVerdict: "approved",
        ciState: "passed",
        overallFileRisk: "autonomous",
        touchesWorkflowOrDeliveryConfig: false,
      }).action,
      "complete_review_only",
    );
    assert.ok(fs.existsSync(installDeliverySkill(skillsDir)));
    const probe = new ZeroTokenProbeTracker();
    assert.equal(probe.evaluate({ probeId: "p1", healthy: true, output: "ok", at: "2026-11-12T00:00:00Z" }).shouldWakeAgent, false);
    const receiptParsed = parseAgentReceipt('```sugent-receipt\n{"status":"completed","summary":"done","events":[]}\n```');
    assert.equal(receiptParsed.ok, true);
    const susp = new SuspendedRoundStore(tmpDir);
    susp.suspend({
      roundId: "r-susp",
      sessionId: "s-1",
      parentTrigger: resetTrigger,
      approval: { approvalId: "ap-1", prompt: "ok?", riskLevel: "high" },
      suspendedAt: "2026-11-12T00:00:00Z",
    });
    assert.equal(susp.resume("r-susp", { approved: true, decidedBy: "owner", resumedAt: "2026-11-12T00:01:00Z" }).checkpoint.status, "resumed");

    // 10. LLM Provider 与账户 OAuth/OIDC 全链路解耦契约验证
    const provDir = path.join(tmpDir, "decoupled-providers");
    const provReg = new ProviderRegistry(provDir);
    const ollamaUrl = ["http:", "", "127.0.0.1:11434", "v1"].join("/");
    provReg.upsertProvider({ id: "local-ollama", preset: "ollama", baseUrl: ollamaUrl, enabled: true });
    provReg.upsertProvider({ id: "ant-main", preset: "anthropic", apiKey: "tok-ant-verify", enabled: true });
    provReg.setRoleRouting({ executor: "ant-main/claude-sonnet-4-6" });
    assert.equal(provReg.hasActiveConnection(), true);
    assert.equal(provReg.resolveModelTarget(provReg.getRoleRouting().executor).provider?.preset, "anthropic");

    const catalog = new SugentModelCatalog(provDir);
    assert.deepEqual(catalog.getModelInfo("anthropic/claude-sonnet-4-6").endpoints, ["anthropic", "openai"]);
    assert.equal(catalog.getModelInfo("ollama/qwen3:32b").rates?.input, 0);
    assert.equal(catalog.getModelInfo("gemini-web2api/gemini-3.1-pro-thinking").context, 36_000);
    assert.equal(resolveGeminiWeb2ApiUrls().adminUrl.endsWith("/admin/"), true);

    const budgetLedger = new LocalBudgetLedger(provDir);
    const tNov = Date.parse("2026-11-12T12:00:00.000Z");
    const tNov2 = Date.parse("2026-11-12T12:05:00.000Z");
    const tDec = Date.parse("2026-12-01T00:00:00.000Z");
    budgetLedger.setBotBudget("default", { enabled: true, limitUsd: 10 }, tNov);
    assert.equal(budgetLedger.recordUsageCost("default", 8.5, tNov).lowReserve, true);
    assert.equal(budgetLedger.recordUsageCost("default", 2.0, tNov2).exhausted, true);
    assert.equal(budgetLedger.getBotBudgetStatus("default", tDec).usedUsd, 0);

    const authMgr = new SugentAuthManager({ dataDir: provDir });
    assert.equal(authMgr.status().mode, "none");
    assert.equal(authMgr.status().signedIn, false);
    authMgr.configure({ mode: "google", clientId: "verify-google-desktop", clientSecret: "verify-secret" });
    assert.equal(authMgr.getConfig().issuer, GOOGLE_OIDC_ISSUER);
    assert.equal(authMgr.getConfig().hasClientSecret, true);
    authMgr.cancelLogin();

    // 11. P0 Auth Broker 预设、P1 幕僚耳麦桥接与 P2 成本沙盘/零知识加密契约验证
    const brokerPreset = buildBrokerDesktopAuthConfig({ idpHint: "wechat" });
    assert.equal(brokerPreset.clientId, "sugent-desktop");
    assert.equal(brokerPreset.idpHint, "wechat");

    const sandboxSim = simulateMonthlyRoleCosts({
      roleModels: {
        assessor: "deepseek-chat",
        executor: "claude-sonnet-4-6",
        computerUse: "gpt-4.1-mini",
        steward: "deepseek-chat",
      },
      preset: "opc-standard",
      catalog,
      ledger: budgetLedger.getBotBudgetStatus("default", tDec),
    });
    assert.ok(sandboxSim.monthlySavingsUsd > 0);

    const syncKeys = deriveSyncKeyHierarchy({
      passphrase: "sugent-verify-passphrase-2026",
      kdfIterations: 100_000,
    });
    const zkEnv = sealZeroKnowledgeEnvelope({
      plaintextPayload: { secretNote: "OPC_VERIFY_CANARY" },
      keyHierarchy: syncKeys,
      subjectSub: "usr_verify_0001",
      payloadType: "knowledge-graph",
      lamportClock: 3,
      deviceId: "dev_verify",
    });
    assert.equal(JSON.stringify(zkEnv).includes("OPC_VERIFY_CANARY"), false);
    const openedZk = openZeroKnowledgeEnvelope({
      envelope: zkEnv,
      passphrase: "sugent-verify-passphrase-2026",
      expectedSubjectSub: "usr_verify_0001",
      expectedPayloadType: "knowledge-graph",
    });
    assert.equal(openedZk.payload.secretNote, "OPC_VERIFY_CANARY");

    const bridge = new ConciergeChannelBridge({
      dataDir: provDir,
      knowledgeGraph: kg,
      resolveActorRole: () => "external_peer",
      defaultTransport: {
        notifyOwner: async () => {},
        sendPeerDirectMessage: async () => {},
      },
    });
    assert.equal(bridge.isEnabled(), false);
    bridge.updateConfig({ enabled: true, ownerDisplayName: "主理人" });
    assert.equal(bridge.isEnabled(), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// 12. Sprint 1 五维生命账本与 Universal Dropzone 联调契约断言
{
  const s1Dir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-sprint1-verify-"));
  try {
    const s1Kg = new SugentKnowledgeGraph(s1Dir);
    const s1Budget = new LocalBudgetLedger(s1Dir);
    s1Budget.setBotBudget("default", { enabled: true, limitUsd: 25 });
    const ledger = new StewardshipLedger({ dataDir: s1Dir, knowledgeGraph: s1Kg, budgetLedger: s1Budget });
    const gatewayConfig = resolveSugentGatewayConfig(undefined, {
      SUGENT_GATEWAY_MODE: "byok",
      SUGENT_MODEL_ASSESSOR: "ollama/qwen3:8b",
      SUGENT_MODEL_EXECUTOR: "ollama/qwen3:32b",
      SUGENT_MODEL_STEWARD: "deepseek/deepseek-chat",
    });
    const dropzone = new UniversalDropzone({ ledger, knowledgeGraph: s1Kg, gatewayConfig });

    assert.equal(MAX_ACTIVE_GOALS, 3);
    ledger.upsertGoal({ id: "g1", partition: "personal_life", title: "健康作息", northStarCriterion: "23点前休息" });
    ledger.upsertGoal({ id: "g2", partition: "work_project", title: "交付核心架构", northStarCriterion: "门禁全绿" });
    ledger.upsertGoal({ id: "g3", partition: "work_project", title: "成本可控", northStarCriterion: "月度不超支" });
    assert.throws(
      () => ledger.upsertGoal({ id: "g4", partition: "personal_life", title: "超额目标", northStarCriterion: "应被拦截" }),
      (err) => err instanceof StewardshipLedgerError && err.code === "GOAL_CAP_EXCEEDED",
    );
    assert.equal(ledger.queryContext("", "owner_private").budgetStatus?.limitUsd, 25);

    ledger.upsertRelationship({ id: "rel-owner", partition: "personal_life", subjectType: "owner_trust", name: "Owner" });
    for (let i = 0; i < 3; i++) ledger.recordVerifiedObservation("rel-owner");
    assert.throws(
      () => ledger.promoteTrustTier("rel-owner", "L3_shadow_autonomous", { ownerConfirmed: false }),
      (err) => err instanceof StewardshipLedgerError && err.code === "TRUST_PROMOTION_DENIED",
    );
    assert.equal(ledger.promoteTrustTier("rel-owner", "L3_shadow_autonomous", { ownerConfirmed: true }).trustTier, "L3_shadow_autonomous");
    assert.equal(ledger.applyOwnerTrustDirective("rel-owner", "降级到L1耳麦提词").trustTier, "L1_whisper_prompt");

    ledger.addGuardrail({ id: "tb-work", partition: "work_project", kind: "tombstone", statement: "外发报价禁止低于八折", evidenceSource: "复盘记录" });
    const capRes = await dropzone.handle({
      inputId: "s1-cap", channel: "tray_drop", partition: "personal_life",
      text: "记一下护照与身份证扫描件位置", filePaths: ["/tmp/archive/id-card.pdf"], receivedAtIso: "2026-11-20T09:00:00.000Z",
    });
    assert.equal(capRes.intent === "capture" && !capRes.receiptLine.includes("\n") && capRes.selectedModel === "ollama/qwen3:8b", true);
    assert.equal(ledger.snapshotForCaller("work_project").relationships.some((r) => r.partition === "personal_life"), false);
    const workRecall = await dropzone.handle({ inputId: "s1-rw", channel: "feishu", callerDomain: "work_project", text: "查一下身份证扫描件在哪", receivedAtIso: "2026-11-20T09:01:00.000Z" });
    assert.equal(workRecall.intent === "recall" && workRecall.matchedRefs.includes("/tmp/archive/id-card.pdf"), false);
    const ownerRecall = await dropzone.handle({ inputId: "s1-ro", channel: "desktop_hotkey", callerDomain: "owner_private", text: "查一下身份证扫描件在哪", receivedAtIso: "2026-11-20T09:02:00.000Z" });
    assert.equal(ownerRecall.intent === "recall" && ownerRecall.matchedRefs.includes("/tmp/archive/id-card.pdf"), true);

    const advRes = await dropzone.handle({ inputId: "s1-adv", channel: "weixin", callerDomain: "work_project", text: "客户要求报价打七折，怎么谈？", receivedAtIso: "2026-11-20T09:03:00.000Z" });
    assert.equal(advRes.intent === "advise" && advRes.guardrailWarnings.some((w) => w.includes("[证伪墓碑预警]")), true);
    const delRes = await dropzone.handle({ inputId: "s1-del", channel: "weixin", callerDomain: "owner_private", text: "帮我办理护照换证，并整理线下材料", receivedAtIso: "2026-11-20T09:04:00.000Z" });
    assert.equal(delRes.intent === "delegate" && delRes.mode === "human_prep_bundle", true);
    assert.ok(delRes.bundle.checklist.length >= 3 && delRes.bundle.localMaterials.some((m) => m.localPath === "/tmp/archive/id-card.pdf"));
    assert.ok(ledger.snapshotForCaller("owner_private").commitments.some((c) => c.id === delRes.followupCommitmentId && c.status === "open"));
  } finally {
    fs.rmSync(s1Dir, { recursive: true, force: true });
  }
}

// 13. Sprint 2 主动伴行与多表面 Antigravity 桥接联调契约断言
{
  const s2Dir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-sprint2-verify-"));
  try {
    const nowIso = "2026-11-20T12:00:00.000Z";
    const nowMs = Date.parse(nowIso);
    const repoDir = path.join(s2Dir, "workspace", "demo-app");
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, ".git", "config"), '[remote "origin"]\n\turl = git@ssh-alias:ExampleOrg/DemoApp.git\n');
    assert.equal(canonicalizeProjectKey({ remoteUrl: "git@ssh-alias:ExampleOrg/DemoApp.git" }), "repo:exampleorg/demoapp");

    const ideDbPath = path.join(s2Dir, "home", ".gemini", "antigravity-ide", "conversation_summaries.db");
    fs.mkdirSync(path.dirname(ideDbPath), { recursive: true });
    const db = new DatabaseSync(ideDbPath);
    try {
      db.exec("CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT, step_count INTEGER, last_modified_time TEXT, workspace_uris TEXT, status TEXT, project_id TEXT, agent_name TEXT, parent_conversation_id TEXT, nesting_depth INTEGER, not_fully_idle INTEGER, killed INTEGER, last_user_input_time TEXT, last_user_input_step_index INTEGER)");
      const ins = db.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      ins.run("conv-root-1", "Implement Sprint 2 bridge", "Ready for review", 5, "2026-11-20 09:00:00+00:00", JSON.stringify([repoDir]), "CASCADE_RUN_STATUS_IDLE", "", "main", "", 0, 0, 0, "2026-11-20 08:50:00+00:00", 2);
      ins.run("conv-sub-1", "Helper worker", "Done", 2, "2026-11-20 08:55:00+00:00", JSON.stringify([repoDir]), "CASCADE_RUN_STATUS_IDLE", "", "sub", "conv-root-1", 1, 0, 0, "", -1);
    } finally {
      db.close();
    }

    const reader = new AntigravityStateReader({ homeDir: path.join(s2Dir, "home"), nodeId: "node-a", bootstrappedAtMs: nowMs - 4 * 3_600_000, nowMs: () => nowMs });
    const scan1 = reader.scan();
    assert.deepEqual(scan1.surfacesScanned, ["ide"]);
    assert.equal(scan1.sessions.length === 1 && scan1.sessions[0].subagentCount === 1, true);
    assert.equal(scan1.sessions[0].projectKey, "repo:exampleorg/demoapp");
    assert.equal(reader.scan().probeDecision.shouldWakeAgent, false);

    const fleetPath = path.join(s2Dir, ".ops_fleet_state.json");
    fs.writeFileSync(fleetPath, JSON.stringify({ collisions: [{ id: "col-1", projectKey: "repo:exampleorg/demoapp", nodeId: "node-b", summary: "Concurrent edits", updatedAtIso: nowIso }] }));
    const fleetEvents = new FleetPulseReader(fleetPath).read();
    assert.equal(fleetEvents.length === 1 && fleetEvents[0].urgency === "urgent", true);

    const s2Ledger = new StewardshipLedger({ dataDir: s2Dir });
    s2Ledger.upsertGoal({ id: "g-stalled", partition: "work_project", title: "核心里程碑", northStarCriterion: "全链路验证", lastProgressAt: "2026-11-10T00:00:00.000Z", stallThresholdDays: 7 }, { nowIso });
    s2Ledger.upsertCommitment({ id: "c-due", partition: "work_project", direction: "i_owe", summary: "提交集成回归报告", counterpartyOrRef: "team", dueAt: "2026-11-21T12:00:00.000Z", remindLeadDays: 3 }, nowIso);
    const candidates = scanLedgerImbalances(s2Ledger.snapshotForCaller("owner_private"), nowIso, { fleetPulses: [...scan1.cadenceEvents, ...fleetEvents] });
    assert.ok(candidates.some((c) => c.kind === "goal_imbalance") && candidates.some((c) => c.kind === "fleet_collision_or_alert" && c.urgency === "urgent"));

    const gate = createAttentionBudgetGate(undefined, 2);
    const quietRes = gate.evaluateAndRecord(candidates, "2026-11-20", true);
    assert.equal(quietRes.emitNow.length === 1 && quietRes.emitNow[0].urgency === "urgent", true);
    assert.ok(quietRes.foldToMorningDigest.some((c) => c.targetRefId === "conv-root-1"));
    assert.equal(filterSupersededBeforeSend(quietRes.foldToMorningDigest, (c) => c.targetRefId === "conv-root-1").supersededIds.length, 1);
    const morning = gate.drainMorningDigest("2026-11-21", (c) => c.targetRefId === "conv-root-1");
    assert.equal(morning.supersededIds.length === 1 && !morning.emitNow.some((c) => c.targetRefId === "conv-root-1"), true);
    assert.ok(morning.emitNow.length >= 2);

    const privacy = new ProjectPrivacyRegistry({ dataDir: s2Dir, registeredProjectKeys: ["repo:exampleorg/demoapp"] });
    const tier2 = privacy.setProjectTier("repo:exampleorg/demoapp", 2);
    const tier1 = privacy.setProjectTier("repo:exampleorg/demoapp", 1);
    assert.equal(tier1.tierEpoch > tier2.tierEpoch, true);
    assert.equal(privacy.sanitizeForProjectTier({ summary: "stale" }, "repo:exampleorg/demoapp", tier2.tierEpoch).staleEpoch, true);
    assert.deepEqual(privacy.sanitizeForProjectTier({ summary: "hidden", projectKey: "repo:exampleorg/demoapp" }, "repo:exampleorg/demoapp", tier1.tierEpoch).strippedFields, ["summary"]);

    assert.throws(() => stageSugentStewardPluginHooks(path.join(os.homedir(), ".gemini", "config", "hooks.json"), "sugent-hook"));
    const staged = stageSugentStewardPluginHooks(path.join(s2Dir, "plugins"), "sugent-hook");
    assert.ok(fs.existsSync(staged.pluginJsonPath) && fs.existsSync(staged.hooksJsonPath));

    const hookSink = new AntigravityHookSink({ registry: new PersonalSourceRegistry(), nodeId: "node-a", defaultOwnerId: "owner-1", allowedSenderIds: ["owner-1"] });
    const subHook = hookSink.processHookStdin(JSON.stringify({ hookEventName: "Stop", cwd: path.join(repoDir, "worktrees", "conv-root-1", "swarm-1"), nestingDepth: 1 }));
    assert.equal(subHook.shortCircuited && subHook.stdoutJson === '{"decision":"allow"}', true);
    const rootHook = hookSink.processHookStdin(JSON.stringify({ hookEventName: "Stop", conversationId: "conv-root-1", cwd: repoDir, ownerId: "owner-1", summary: "Done" }));
    assert.equal(!rootHook.shortCircuited && rootHook.trigger?.sourceKind === "antigravity" && rootHook.stdoutJson === '{"decision":"allow"}', true);
  } finally {
    fs.rmSync(s2Dir, { recursive: true, force: true });
  }
}

// 16. Sprint 3: 安全信封产物理解 + 8 跳熔断调度 + MCP 插件隔离校验
{
  const s3Dir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-sprint3-verify-"));
  try {
    const brain = path.join(s3Dir, "home", ".gemini", "antigravity", "brain", "conv-v3");
    fs.mkdirSync(brain, { recursive: true });
    fs.writeFileSync(path.join(brain, "walkthrough.md"), "## 已通过测试 passed");
    const priv = new ProjectPrivacyRegistry({ dataDir: s3Dir });
    const l = new StewardshipLedger({ dataDir: s3Dir });
    l.upsertResource({ partition: "personal_life", kind: "personal_archive", title: "秘密档案", localUriOrPath: "/tmp/p.pdf", metadata: {} });
    const pipe = new ArtifactComprehensionPipeline({ homeDir: path.join(s3Dir, "home"), sealWorkspaceDir: path.join(s3Dir, "ws"), privacyRegistry: priv, ledger: l });
    const comp = await pipe.comprehendSession({ conversationId: "conv-v3", projectKey: "repo:acme/s3" });
    assert.equal(comp.allowed && (fs.statSync(comp.envelope.absoluteFilePath).mode & 0o777) === 0o400, true);

    const disp = new AntigravityDispatcher({
      runner: { async getConversationMetadata() { return { exists: true, nestingDepth: 0 }; }, async sendMessage() { return { ok: true, exitCode: 0 }; }, async newConversation() { return { exitCode: 0 }; } },
    });
    assert.equal((await disp.resumeSession({ conversationId: "conv-v3", content: "loop", hopCount: 9 })).errorCode, "HOP_CIRCUIT_BROKEN");

    const mcp = new SugentStewardMcpServer({ ledger: l, privacyRegistry: priv, canonPublisher: new LocalDiffCanonPublisher() });
    const rec = await mcp.callTool("steward_recall_context", { projectKey: "repo:acme/s3", query: "秘密" });
    assert.equal(rec.ok && !JSON.stringify(rec).includes("/tmp/p.pdf"), true);
    assert.throws(() => stageSugentStewardPluginMcp(path.join(os.homedir(), ".gemini", "config", "mcp_config.json"), { serverUrl: "http://127.0.0.1:3900/amb/api/steward/mcp" }));
  } finally {
    fs.rmSync(s3Dir, { recursive: true, force: true });
  }
}

// 17. M1–M4 本地代码仓绑定、双向文件透传、Vibe Coding 全链路与防改砖启动印记契约校验
{
  const vDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-vibe-verify-"));
  try {
    const repoDir = path.join(vDir, "repo");
    fs.mkdirSync(repoDir, { recursive: true });
    const bindings = new RepoBindingRegistry({ dataDir: vDir });
    const b = bindings.upsertBinding({ alias: "离线测试仓", repoRoot: repoDir, verifyArgv: [], restartMode: "none" });
    const ledger = new StewardshipLedger({ dataDir: vDir });
    const fileBridge = new HandoffFileBridge({ dataDir: vDir, ledger });
    const suspendedStore = new SuspendedRoundStore(path.join(vDir, "sugent-stewardship"));
    const disp = new AntigravityDispatcher({
      runner: {
        async getConversationMetadata() { return { exists: true, nestingDepth: 0, workspaceUris: [repoDir] }; },
        async sendMessage() { return { ok: true, exitCode: 0 }; },
        async newConversation() { return { conversationId: "33333333-3333-3333-3333-333333333333", exitCode: 0 }; },
      },
    });
    const orch = new VibeCodingPipelineOrchestrator({
      dataDir: vDir,
      bindings,
      fileBridge,
      harnesses: new CodingHarnessRegistry([new AntigravityCodingHarness(disp)]),
      ledger,
      suspendedStore,
      relauncher: new SafeRelaunchCoordinator({ dataDir: vDir }),
    });
    const started = await orch.startTask({
      text: "新增离线导出",
      bindingQuery: b.bindingId,
      channel: "sugent_app",
      useWorktree: false,
      attachments: [{ name: "spec.png", dataBuffer: Buffer.from("PNG"), mime: "image/png" }],
    });
    assert.equal(started.ok, true);
    await orch.onHarnessIdle(started.pipeline.pipelineId);
    assert.equal(orch.getPipeline(started.pipeline.pipelineId).stage, "awaiting_plan_approval");
    await orch.decide({ pipelineId: started.pipeline.pipelineId, rawReplyText: "1" });
    const done = await orch.runVerificationAndPackage(started.pipeline.pipelineId, { changedFilesOverride: ["README.md"] });
    assert.equal(done.stage, "completed");
    writeBootHealthyStamp(vDir, { pid: process.pid, version: "0.1.15", startedAtMs: 12345, startedAtIso: "2026-11-21T00:00:00.000Z" });
    assert.equal(readBootHealthyStamp(vDir)?.version, "0.1.15");
  } finally {
    fs.rmSync(vDir, { recursive: true, force: true });
  }
}

// 18. 能力自感知（构建漂移/动态剧本）与受控本地文档全文读取契约校验
{
  const cDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-cap-verify-"));
  try {
    const manifestPath = path.join(cDir, "sugent-build-manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify({ buildId: "v-1", version: "0.1.15", gitHead: "abc", builtAtIso: "2026-11-21T00:00:00Z", builtAtMs: 1000, capabilityHighlights: ["全文读取"] }));
    const kg = new SugentKnowledgeGraph(path.join(cDir, "kg"));
    const cap = new CapabilityAwarenessEngine({ dataDir: cDir, manifestPath, knowledgeGraph: kg, tools: STEWARD_CAPABILITY_DESCRIPTORS });
    assert.equal(cap.snapshot(1).drift.drifted, false);
    fs.writeFileSync(manifestPath, JSON.stringify({ buildId: "v-2", version: "0.1.15", gitHead: "def", builtAtIso: "2026-11-21T01:00:00Z", builtAtMs: 2000, capabilityHighlights: ["v2"] }));
    assert.equal(cap.snapshot(1).drift.drifted, true);

    const projRoot = path.join(cDir, "proj");
    fs.mkdirSync(projRoot, { recursive: true });
    fs.writeFileSync(path.join(projRoot, "report.md"), `${"A".repeat(1200)}END`);
    const reader = new AuthorizedFileReader({
      homeDir: cDir,
      privacyRegistry: new ProjectPrivacyRegistry({ dataDir: cDir }),
      getProjectRoots: () => [{ projectKey: "repo:acme/proj", displayName: "proj", rootPath: projRoot, sourceKind: "project_workspace" }],
    });
    const readRes = reader.readFile({ fileQuery: "report.md", maxChars: 2000 });
    assert.equal(readRes.ok && readRes.content.endsWith("END"), true);
  } finally {
    fs.rmSync(cDir, { recursive: true, force: true });
  }
}

// 19. 形象工坊（v2 3×2 全身雕塑素体 + 自动切分对齐 + 离线主权装配）契约校验
{
  const aDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-avatar-verify-"));
  try {
    const blankPath = path.resolve("ui", "design", "bots", "blank-visor-toy.png");
    const mannequinPath = path.resolve("ui", "design", "bots", "mannequin-pose-sheet-v2.png");
    const corePosesPath = path.resolve("ui", "design", "bots", "sugent-core-v2-poses.png");
    const corePortPath = path.resolve("ui", "design", "bots", "sugent-core-v2-portrait.png");
    const clayPosesPath = path.resolve("ui", "design", "bots", "clay-atelier-poses.png");
    for (const f of [blankPath, mannequinPath, corePosesPath, corePortPath, clayPosesPath]) assert.equal(fs.existsSync(f), true);

    const blankBuf = fs.readFileSync(blankPath);
    const manBuf = fs.readFileSync(mannequinPath);
    assert.equal(decodePngToRgba(fs.readFileSync(corePosesPath)).width, 1152);
    assert.equal(decodePngToRgba(fs.readFileSync(corePortPath)).width, 256);
    assert.equal(decodePngToRgba(fs.readFileSync(clayPosesPath)).width, 1152);
    assert.equal(POSE_KEYS.length, 6);
    assert.equal(CANONICAL_VISOR_RIG_V1.eyes.length, 2);

    const gridRig = rigPoseSheetImageBuffer(manBuf, { layout: "grid_3x2" });
    assert.equal(decodePngToRgba(gridRig.poseSheetPng).width, 1152);
    assert.equal(decodePngToRgba(gridRig.portraitPng).width, 256);
    assert.equal(gridRig.warnings.length, 0);

    const rigged = rigAvatarImageBuffer(blankBuf, { cleanVisor: true, preserveGlow: true });
    assert.equal(decodePngToRgba(rigged.spritePng).width, 3584);

    const studio = new SugentAvatarStudio(aDir, { env: {}, blankAssetPath: blankPath, mannequinAssetPath: mannequinPath });
    assert.equal(studio.listState().activeId, "sugent-core");
    assert.equal(studio.listState().activePack.schemaVersion, "pose_sheet_v2");
    const imp = studio.importFromImage({ name: "契约测试机", dataBase64: blankBuf.toString("base64") });
    assert.equal(imp.ok && imp.pack.schemaVersion === "pose_sheet_v2", true);
    assert.equal(studio.listState().activeId, imp.pack.id);
    assert.throws(() => studio.deletePack("sugent-core"));
    assert.throws(() => studio.deletePack("clay-atelier"));
    assert.equal(studio.deletePack(imp.pack.id).activeId, "sugent-core");
  } finally {
    fs.rmSync(aDir, { recursive: true, force: true });
  }
}

// 20. 双环自治、心流投递、追问门控、执行仲裁与 SIM 外科隔离契约校验
{
  const mDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-dual-loop-verify-"));
  try {
    const d0 = computeEventDelta({ status: "idle", updatedAtIso: "t1" }, { status: "idle", updatedAtIso: "t2" }, "k", 1000);
    assert.equal(scoreEventSalience({ trigger: { id: "t", sourceKind: "github", text: "ping", threadKey: "th", createdAt: "t2" }, delta: d0, ledger: { goals: [], commitments: [], guardrails: [] }, cadenceState: { quietHoursActive: false }, nowIso: "2026-11-21T10:00:00Z" }).route, "drop_noise");

    const clar = evaluateClarificationAndFocus({ text: "把产品做强", intentHint: "goal_proposal", recalledContacts: [], recalledArchives: [], activeGoals: [], guardrails: [] });
    assert.equal(clar.status === "needs_clarification" && clar.reason === "hollow_goal_criterion", true);

    const relRec = updateToolReliabilityEma(undefined, "cli:agentapi", false, "POLICY", "2026-11-21T10:00:00Z");
    assert.equal(relRec.emaScore === 0.5 && relRec.policyBlockCount === 1, true);
    assert.equal(evaluateExecutionBudgetGate({ evalDecision: { outcome: "accept_act", recommendedRole: "executor" }, trustTier: "L3_shadow_autonomous", riskLevel: "autonomous", budgetStatus: { enabled: true, lowReserve: true, exhausted: false }, cadenceState: { quietHoursActive: false }, activeOwnerTimeWindow: true, recentDeliberationsForGoal: 0, cooldownRemainingSec: 0 }).action, "DOWNGRADE_TO_ASSESSOR");

    const flowRes = evaluateFlowAwareDelivery([{ candidateId: "c1", dedupeKey: "d1", kind: "review_ready", urgency: "normal", title: "T", threeLineBody: ["1", "2", "3"], targetRefId: "g2" }], { dateKey: "2026-11-21", nonUrgentSentCount: 0, dailySoftQuota: 0, quietHoursActive: false, sentDedupeKeys: [], morningDigestQueue: [] }, { mode: "deep_focus", activeGoalId: "g1", flowStrength: 0.9 }, "2026-11-21T10:00:00Z");
    assert.equal(flowRes.holdForBoundary.length === 1 && flowRes.emitNow.length === 0, true);

    const sim = new SugentSIMStore(mDir);
    sim.recordAttempt({ problemId: "P-1", title: "Test problem" }, { attemptId: "a1", roundId: "r1", atIso: "2026-11-21T10:00:00Z", artifactKind: "cordis_plugin", artifactPathOrId: "sugent-ext-demo", portabilityClass: "model_specific", rationale: "r", hypothesis: "h", accepted: true, revalidationStatus: "verified", outcomeDelta: { predictedOutcomes: [], fixed: [], missed: [], ownerRejectedCount: 2, regressionDetected: true }, provenance: { modelRole: "executor", resolvedModelId: "m-old" } });
    assert.equal(sim.flagOnModelSwitch("executor", "m-old", "m-new").length, 1);
    assert.equal(sim.evaluateRegression("a1")?.shouldQuarantine, true);
    quarantineSelfEvolutionArtifact(mDir, { kind: "plugin", idOrName: "sugent-ext-demo", reason: "regression", simAttemptId: "a1", atIso: "2026-11-21T10:05:00Z" });
    assert.equal(listQuarantinedArtifacts(mDir).length, 1);
    assert.equal(runGardenerCycle({ nowIso: "2026-11-21T12:00:00Z", ledger: { version: 1, updatedAt: "2026-11-21T00:00:00Z", relationships: [], goals: [], guardrails: [], commitments: [], resources: [] }, recentRounds: [], hypotheses: [], prevSurpriseMomentum: 0.65, currentSurprise: 0.9, maxStewardTokenBudget: 512 }).driftReport.urgentTriggered, true);
  } finally {
    fs.rmSync(mDir, { recursive: true, force: true });
  }
}

// 21. CLIProxyAPI 全量模型对齐、熔断避让、经验后验反转与离线主权契约校验
{
  const rtDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-rt-verify-"));
  try {
    const reg = new ProviderRegistry(rtDir);
    reg.upsertProvider({ id: "cp", preset: "custom-openai", baseUrl: "http://127.0.0.1:8317/v1", apiKey: "sk-verify", enabled: true, setDefault: true, models: ["gpt-5-nano", "claude-sonnet-4-6", "gemini-4-hydrogen-xhigh", "text-embedding-3-small"] });
    const cat = new SugentModelCatalog(rtDir);
    const pool = new ModelPoolSyncer({ dataDir: rtDir, providers: reg, catalog: cat });
    assert.equal(pool.listChatCandidates().length, 3);

    const exp = new RoutingExperienceStore({ dataDir: rtDir });
    const router = new AdaptiveModelRouter({ pool, experience: exp, providers: reg, catalog: cat });
    const quick = router.planRoute({ role: "steward", text: "记个待办", hasTools: true });
    assert.equal(quick?.primary.rawModelId, "gpt-5-nano");

    pool.recordInfraFailure("cp/gpt-5-nano", 429);
    const quickAfter429 = router.planRoute({ role: "steward", text: "记个待办", hasTools: true });
    assert.notEqual(quickAfter429?.primary.rawModelId, "gpt-5-nano");
    assert.ok(quickAfter429?.skippedCoolingModels.includes("gpt-5-nano"));

    const nl = exp.applyNaturalLanguageDirective("以后写代码优先使用 claude-sonnet-4-6", pool.listChatCandidates().map((e) => e.targetId));
    assert.equal(nl.matched, true);
    const coding = router.planRoute({ role: "executor", text: "修复 TypeScript 编译错误", hasTools: true });
    assert.equal(coding?.primary.rawModelId, "claude-sonnet-4-6");
  } finally {
    fs.rmSync(rtDir, { recursive: true, force: true });
  }
}

// 22. 分层热启动与热更新引擎契约验证 (L0-L3)
{
  const hotDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-hot-verify-"));
  const srcDir = path.join(hotDir, "src-bundle");
  const uiDir = path.join(hotDir, "ui");
  try {
    assert.equal(hasVerifiedActiveOrPendingSlot(hotDir), false);
    fs.mkdirSync(path.join(srcDir, "dist", "src", "sugent"), { recursive: true });
    fs.mkdirSync(path.join(srcDir, "ui"), { recursive: true });
    fs.writeFileSync(path.join(srcDir, "dist", "src", "sugent", "hot-core-entry.js"), "export const ok = true;\n");
    fs.writeFileSync(path.join(srcDir, "ui", "index.html"), "<html>ok</html>\n");
    const keys = generateHotBundleKeyPair();
    const packed = createSignedHotBundle({ sourceRoot: srcDir, version: "0.2.0", privateKeyPem: keys.privateKeyPem, includePaths: ["dist", "ui"] });
    const ver = verifyHotBundleArchive(packed.buffer, { trustedPublicKeys: [keys.publicKeyPem] });
    assert.equal(ver.ok, true);

    const mgr = new HotBundleSlotManager(hotDir);
    const staged = mgr.stageBundleBuffer(packed.buffer, { trustedPublicKeys: [keys.publicKeyPem] });
    assert.equal(staged.ok, true);
    mgr.commitPendingSlot();
    assert.equal(hasVerifiedActiveOrPendingSlot(hotDir), true);
    assert.equal(mgr.resolveBootTarget({ entryPath: "/f/entry.js", uiDir }).slot, staged.slot);
    mgr.resetToFactoryGolden();
    assert.equal(mgr.resolveBootTarget({ entryPath: "/f/entry.js", uiDir }).slot, "factory");

    const pluginsDir = path.join(hotDir, "self-repo", "extensions", "plugins");
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, "verify.mjs"), "export const n = 7;\n");
    fs.writeFileSync(path.join(pluginsDir, "verify.json"), JSON.stringify({ id: "sugent-ext-verify", apiVersion: 1 }));
    const bus = new HotReloadBus({ dataDir: hotDir, uiDir });
    const rel = bus.reloadExtensions();
    assert.equal(rel.pluginCount, 1);
    assert.deepEqual(rel.validIds, ["sugent-ext-verify"]);
    assert.equal((await bus.loadHotPluginModule(path.join(pluginsDir, "verify.mjs"))).n, 7);
    bus.close();
  } finally {
    fs.rmSync(hotDir, { recursive: true, force: true });
  }
}

// 23. Wave P0 统一因果账本、技能结晶沙盒门禁、唯一幕僚通道桥与安全信封契约验证
{
  const p0Dir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-p0-verify-"));
  try {
    // 23.1 统一因果账本路径与历史迁移零丢账
    const legacyDir = path.join(p0Dir, "sugent-ledger");
    const leg = new CausalLedger(legacyDir);
    leg.append({ roundId: "rnd-legacy", kind: "round_triggered", at: "2026-11-23T08:00:00.000Z", title: "历史轮次" });
    const unifiedDir = resolveUnifiedCausalLedgerDir(p0Dir);
    assert.equal(unifiedDir, path.join(p0Dir, "sugent-stewardship"));
    const unified = new CausalLedger(unifiedDir);
    assert.equal(unified.traceRound("rnd-legacy")?.title, "历史轮次");

    // 23.2 技能结晶候选门禁与 12 个激活上限淘汰
    const kg = new SugentKnowledgeGraph(path.join(p0Dir, "kg"));
    const skillsDir = path.join(p0Dir, "skills");
    for (let i = 1; i <= 14; i += 1) {
      kg.applyDelta({
        nodes: [{ id: `wf:p0-${i}`, kind: "workflow", name: `Flow ${i}`, summary: `flow ${i}`, tags: [], reinforcements: 3 + i, steps: ["step1", "step2"] }],
        edges: [],
      });
    }
    assert.equal(kg.crystallizeSkillsToDir(skillsDir, { gated: true, maxActiveSkills: 12 }).length, 0);
    assert.equal(kg.listSkillCandidates().length, 14);
    for (let i = 1; i <= 14; i += 1) assert.equal(kg.approveSkillCandidate(`wf:p0-${i}`), true);
    assert.equal(kg.crystallizeSkillsToDir(skillsDir, { gated: true, maxActiveSkills: 12 }).length, 12);
    assert.equal(fs.readdirSync(skillsDir).length, 12);

    // 23.3 主理人跨渠道唯一幕僚路由与公私隔离
    let converseCalls = 0;
    let retryCalls = 0;
    const ownerRouter = new OwnerChannelStewardRouter({
      steward: {
        async converse(input) {
          converseCalls += 1;
          return { ok: true, intent: "llm_agent", reply: `已由唯一幕僚响应(${input.channel}): ${input.text}` };
        },
        async retryLastTurnStronger() {
          retryCalls += 1;
          return { ok: true, intent: "llm_agent", reply: "已升级至前沿模型重新推理" };
        },
      },
    });
    const guestRes = await ownerRouter.tryHandleInbound({ channel: "weixin", peerId: "guest", isGroup: false, isOwnerPeer: false, text: "查家底" });
    assert.equal(guestRes.handled, false);
    const groupRes = await ownerRouter.tryHandleInbound({ channel: "feishu", peerId: "grp", isGroup: true, isOwnerPeer: true, text: "查家底" });
    assert.equal(groupRes.handled, false);
    const ownerRes = await ownerRouter.tryHandleInbound({ channel: "weixin", peerId: "owner-1", isGroup: false, isOwnerPeer: true, text: "看今日重点" });
    assert.equal(ownerRes.handled, true);
    assert.equal(converseCalls, 1);
    const retryRes = await ownerRouter.tryHandleInbound({ channel: "weixin", peerId: "owner-1", isGroup: false, isOwnerPeer: true, text: "换更强模型重试" });
    assert.equal(retryRes.handled, true);
    assert.equal(retryCalls, 1);

    // 23.4 宿主 RuleEvents 安全信封越权剥离与只读隔离
    const capturedEvents = [];
    const enveloped = createEnvelopedRuleEventSink(
      { emitRuleEvent(_src, ev) { capturedEvents.push(ev); return ["rule-1"]; } },
      { privilegedFieldMode: "strip", resolveWorkspaceDir: () => path.join(p0Dir, "ws") },
    );
    enveloped.emitRuleEvent("github:sugent/repo", { id: "ev-1", type: "push", title: "raw untrusted", cwd: "/root", permission: "all" });
    assert.equal(capturedEvents.length, 1);
    assert.equal(capturedEvents[0].cwd, undefined);
    assert.equal(capturedEvents[0].permission, undefined);
    assert.equal(capturedEvents[0].title, undefined);
    assert.ok(fs.existsSync(path.join(p0Dir, "ws", capturedEvents[0].contextFile)));
  } finally {
    fs.rmSync(p0Dir, { recursive: true, force: true });
  }
}

// 24. GCE 常驻中枢、微信单持有者守卫与 /ops 舰队桥接契约 (Step 1)
{
  const mockOpsOrigin = ["https:", "", "ops.sugent.internal"].join("/");
  // 24.1 mode: none 零请求静默与单持有者守卫
  const emptyCfg = resolveOpsBridgeConfig({});
  assert.equal(emptyCfg.enabled, false);
  let zeroFetchCalls = 0;
  const offlineBridge = new OpsBridgeClient({
    ...emptyCfg,
    fetchImpl: async () => {
      zeroFetchCalls += 1;
      return new Response("{}", { status: 200 });
    },
  });
  const skippedPulse = await offlineBridge.pushPulse([]);
  assert.equal(skippedPulse.ok, false);
  assert.equal(skippedPulse.skipped, true);
  assert.equal(zeroFetchCalls, 0);

  assert.equal(evaluateWeixinSingleHolderGuard({}).blocked, false);
  assert.equal(
    evaluateWeixinSingleHolderGuard({ OPS_BASE_URL: mockOpsOrigin, SUGENT_NODE_ID: "local-mac" }).blocked,
    true,
  );
  assert.equal(
    evaluateWeixinSingleHolderGuard({
      OPS_BASE_URL: mockOpsOrigin,
      SUGENT_NODE_ID: "gce-hub",
      SUGENT_WEIXIN_OWNER_NODE: "gce-hub",
    }).blocked,
    false,
  );

  // 24.2 Tier 0/1/2 字段裁剪与 JWT 续期 + 幂等回执
  const t0Pruned = pruneProjectPulseForTier({
    projectKey: "repo:owner/private-ledger",
    displayName: "Private Ledger",
    tier: 0,
    updatedAtIso: "2026-11-24T12:00:00.000Z",
    sessionCount: 2,
    runningSessionCount: 1,
    subagentCount: 1,
    workspaceRoot: "/Users/owner/secret",
    summary: "secret numbers",
  });
  assert.equal(t0Pruned.displayName, undefined);
  assert.equal(t0Pruned.sanitizedSummary, undefined);
  assert.ok(/^proj-[a-f0-9]{8}$/.test(t0Pruned.codeName));

  let nowSim = 1_700_000_000_000;
  let authSeq = 0;
  let ackCalls = 0;
  const hubBridge = new OpsBridgeClient({
    baseUrl: mockOpsOrigin,
    nodeToken: "tok-hub",
    nodeId: "gce-hub",
    stewardHubNodeId: "gce-hub",
    nowMs: () => nowSim,
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/api/ops/node/auth")) {
        authSeq += 1;
        return new Response(JSON.stringify({ token: `jwt-${authSeq}`, expiresInSec: 3600 }), { status: 200 });
      }
      if (url.endsWith("/ack")) ackCalls += 1;
      return new Response(JSON.stringify({ ok: true, projects: [], pendingInbox: [] }), { status: 200 });
    },
  });
  await hubBridge.stewardPending();
  await hubBridge.stewardPending();
  assert.equal(authSeq, 1);
  nowSim += 56 * 60_000;
  await hubBridge.stewardPending();
  assert.equal(authSeq, 2);
  await hubBridge.ackCommand("cmd-gate-1", { status: "completed" });
  const dupAck = await hubBridge.ackCommand("cmd-gate-1", { status: "completed" });
  assert.equal(dupAck.idempotent, true);
  assert.equal(ackCalls, 1);
}

// 25. Wave P1 零填表冷启动、ACP 编码军团、隐藏 Git 快照与跨平台加固契约
{
  const p1Dir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-verify-p1-"));
  try {
    // 25.1 P1.1 零填表冷启动探针与单动作落账 + 零驻留拍板闭环
    const p1Ledger = new StewardshipLedger({ dataDir: path.join(p1Dir, "ledger") });
    const p1Susp = new SuspendedRoundStore(path.join(p1Dir, "susp"));
    const probe0 = probeColdStartReadiness({ ledger: p1Ledger, whichFn: (b) => b === "opencode" });
    assert.equal(probe0.needsColdStart, true);
    assert.equal(probe0.requiresForm, false);
    assert.deepEqual(probe0.detectedClis, ["opencode"]);

    const dropRes = ingestColdStartDrop({
      ledger: p1Ledger,
      suspendedStore: p1Susp,
      forwardedText: "李工：明天前核对三期设备调试报告",
      nowIso: "2026-11-24T10:00:00.000Z",
    });
    assert.equal(dropRes.resource.kind, "personal_archive");
    assert.equal(dropRes.commitment.counterpartyOrRef, "李工");
    const doneDemo = completeColdStartApprovalDemo({
      suspendedStore: p1Susp,
      ledger: p1Ledger,
      roundId: dropRes.roundId,
      approved: true,
    });
    assert.equal(doneDemo.commitmentStatus, "closed");

    // 25.2 P1.2 ACP 标准安全参数向量、注册中心与双轨配额
    for (const b of ["claude_code", "codex", "opencode", "pi"]) {
      const spec = buildSafeAcpCliArgv(b, { workspacePath: p1Dir });
      assert.ok(!spec.argv.join(" ").includes("dangerously-skip-permissions"));
    }
    const reg = new CodingHarnessRegistry([
      new AcpCodingHarness({ backend: "claude_code" }),
      new AcpCodingHarness({ backend: "codex" }),
      new AcpCodingHarness({ backend: "opencode" }),
      new AcpCodingHarness({ backend: "pi" }),
    ]);
    assert.equal(reg.listBackends().length, 4);
    const dualBudget = new DualTrackCodingBudget({ subscriptionMaxTurnsPerWindow: 1, subscriptionWindowMs: 5_000 });
    dualBudget.recordSubscriptionTurn("claude_code", 1_000);
    assert.equal(dualBudget.canDispatchSubscription("claude_code", 2_000).allowed, false);
    assert.equal(dualBudget.canDispatchSubscription("claude_code", 7_000).allowed, true);

    // 25.3 P1.3 PR 安全信封回灌与 P1.4 懒权限 + WSL2 拓扑检测
    const prOut = stagePrReviewToHandoff({
      workspacePath: p1Dir,
      roundId: "gate-pr-1",
      repoSlug: "ldc861117/sugent",
      prNumber: 7,
      ciFailureLog: "Test failed",
      rawUntrustedPayload: { cwd: "/root", permission: "all" },
    });
    assert.ok(prOut.strippedFields.includes("cwd"));
    assert.ok(fs.existsSync(prOut.specFilePath));

    const wtIso = allocateWorktreeIsolationEnv({ worktreePath: path.join(p1Dir, "wt-a"), slotIndex: 2 });
    assert.ok(fs.existsSync(wtIso.tmpDir));
    const permGate = new LazyDesktopPermissionGate();
    assert.equal(permGate.onAppBoot().bootChecksTriggered, 0);
    assert.equal(inspectWorkspaceFsTopology("/mnt/c/work/demo", { platform: "linux" }).isSlowCrossOsMount, true);
    assert.ok(new GitRefCheckpointManager());
  } finally {
    fs.rmSync(p1Dir, { recursive: true, force: true });
  }
}

// 26. Wave P2 合盖离线韧性、微信 iLink 3 秒转发参谋与端-边联邦标杆武器包契约
{
  const p2Dir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-verify-p2-"));
  try {
    const pwr = new PowerSaveBlockerController({ maxDurationMs: 8 * 3600_000 });
    const ps1 = pwr.enable("prevent-app-suspension", { durationMs: 24 * 3600_000, nowMs: 1_000 });
    assert.equal(ps1.active, true);
    assert.equal(ps1.expiresAtMs, 1_000 + 8 * 3600_000);
    assert.equal(pwr.checkAutoExpire(1_000 + 8 * 3600_000), true);

    const p2Kg = new SugentKnowledgeGraph(path.join(p2Dir, "kg"));
    const p2Budgets = new LocalBudgetLedger(path.join(p2Dir, "budgets"));
    const host = new SugentStewardHostService({
      dataDir: p2Dir,
      knowledgeGraph: p2Kg,
      localBudgets: p2Budgets,
      nowIso: () => "2026-11-25T10:00:00.000Z",
    });
    host.ledger.upsertGoal({ id: "g-p2", partition: "work_project", title: "收官 Wave P2", northStarCriterion: "14天零越权" });
    host.ledger.upsertRelationship({
      id: "rel-chen",
      partition: "work_project",
      name: "陈总",
      trustTier: "L1_whisper_prompt",
      taboos: ["不要承诺驻场包干"],
    });
    host.ledger.addGuardrail({ id: "gr-p2", partition: "work_project", kind: "hard_redline", statement: "标准账期不得超过 60 天，严禁零首付" });
    host.ledger.upsertResource({
      id: "res-p2",
      partition: "work_project",
      kind: "personal_archive",
      title: "陈总项目底价单",
      localUriOrPath: "/Users/private/secret-quote.pdf",
      metadata: { counterparty: "陈总", floorPriceWan: 20, floorPrice: 200000, maxPaymentDays: 60 },
    });

    const digest = buildOfflineLedgerDigest(host.ledger, { nowIso: "2026-11-25T10:00:00.000Z" });
    assert.equal(JSON.stringify(digest).includes("secret-quote.pdf"), false);

    const vault = new E2eeOfflineDigestVault({ dataDir: p2Dir, kdfIterations: 100_000 });
    const sealedSnap = vault.sealDigestSnapshot({
      ledger: host.ledger,
      passphrase: "gate-p2-passphrase-2026",
      subjectSub: "usr_gate_p2",
      deviceId: "mac-main",
      lamportClock: 1,
    });
    assert.equal(vault.openDigestSnapshot({ envelope: sealedSnap, passphrase: "gate-p2-passphrase-2026", expectedSubjectSub: "usr_gate_p2" }).goals[0].title, "收官 Wave P2");
    const taskEnv = vault.enqueueEncryptedOfflineTask({
      task: { taskId: "wake-1", summary: "开盖后核对设备台账", counterpartyOrRef: "陈总", partition: "work_project" },
      passphrase: "gate-p2-passphrase-2026",
      subjectSub: "usr_gate_p2",
      mobileDeviceId: "iphone-pwa",
      lamportClock: 2,
    });
    const drained = vault.drainOfflineTaskQueueOnWake({
      envelopes: [taskEnv, taskEnv],
      passphrase: "gate-p2-passphrase-2026",
      expectedSubjectSub: "usr_gate_p2",
      ledger: host.ledger,
    });
    assert.equal(drained.ingestedCount, 1);
    assert.equal(drained.skippedDuplicateCount, 1);

    const wxGuard = new WeixinAdaptiveQuotaGuard({ lowWatermark: 3, criticalWatermark: 1 });
    assert.equal(wxGuard.routeProactivePush({ peerId: "wx_1", title: "常规提醒", body: "ok", urgency: "normal", remainingQuota: 2, channelState: "connected" }).action, "buffered_low_quota");
    assert.equal(wxGuard.flushCoalescedDigest("wx_1", 2).flushedCount, 1);
    assert.equal(wxGuard.routeProactivePush({ peerId: "wx_1", title: "配额耗尽", body: "warn", urgency: "urgent", remainingQuota: 0, channelState: "expired" }).action, "fallback_channel");

    const brief = host.briefForwardedWeixinChat({
      rawForwardedText: "[合并转发的聊天记录]\n陈总: 能不能降到 15 万，走账期 90 天零首付先驻场包干？",
    });
    assert.equal(brief.complianceMode, COMPLIANCE_MODE);
    assert.ok(brief.triggeredRedlines.some((r) => r.includes("报价破底价红线")));
    assert.equal(fs.existsSync(brief.envelopePath), true);

    assert.equal(listWeaponPackages().length, 2);
    assert.equal(BUILTIN_WEAPON_PACKAGES["industrial-fde-diagnostics"].requiresHumanStagingGate, true);
    const fdeOut = host.runIndustrialFdePack({
      batchId: "gate-fde-01",
      records: [
        { ticketId: "T1", station: "总装A", category: "气路异常", downtimeMinutes: 75, slaHoursLimit: 2, elapsedHours: 3, description: "停机", rawExtra: { cwd: "/etc" } },
        { ticketId: "T2", station: "总装A", category: "吊装等待", downtimeMinutes: 30, slaHoursLimit: 2, elapsedHours: 2.5, description: "重复热点" },
      ],
    });
    assert.equal(fdeOut.severity, "P0");
    assert.equal(fdeOut.coworkDraft.status, "PENDING_REVIEW");
    assert.ok(fdeOut.envelope.strippedFields.includes("cwd"));

    const contractBlocked = host.runContractGuardPack({
      inquiryId: "INQ-GATE-1",
      counterparty: "陈总",
      quotedUnitPrice: 160000,
      requestedPaymentDays: 90,
      rawContractText: "乙方承担无限连带责任，零首付验收后 90 天结算。",
    });
    assert.equal(contractBlocked.verdict, "block");

    const contractSafe = runContractQuoteGuardPack({
      workspaceDir: p2Dir,
      inquiryId: "INQ-GATE-2",
      counterparty: "陈总",
      quotedUnitPrice: 220000,
      requestedPaymentDays: 45,
      rawContractText: "乙方不承担无限连带责任，首付 50% 验收后 45 天结清。",
      ledger: host.ledger,
    });
    assert.equal(contractSafe.verdict, "pass");

    const soak = new WeaponSoakTelemetryLedger(p2Dir);
    for (let d = 1; d <= 14; d += 1) {
      soak.recordPackRun({
        packId: "industrial-fde-diagnostics",
        dateKey: `2026-11-${String(d).padStart(2, "0")}`,
        minutesSaved: 40,
        baselineFlagshipUsd: 2.0,
        actualRoutedUsd: 0.5,
        redlinesCaught: 1,
      });
    }
    const proof = soak.exportCommercialProofSummary(14);
    assert.equal(proof.soakTargetMet, true);
    assert.equal(proof.unauthorizedIncidents, 0);
  } finally {
    fs.rmSync(p2Dir, { recursive: true, force: true });
  }
}

console.log(
  "verify:sugent — 全部核心契约断言通过 (M1.1–M1.6 / M2.1 / Cowork 联邦 / P0 Broker + P1 幕僚耳麦 + P2 BYOK 诊断与零知识加密同步 / Sprint 1–3 / M1–M4 Vibe Coding 闭环 / 能力自感知与全文读取 / 形象工坊与桌宠契约 / M-Auto 1–4 双环自治与 SIM 演进 / M1–M3 全量模型同步与经验驱动自适应路由 / L0–L3 分层热启动与热更新 / Wave P0 双脑归一与宿主主循环合龙 / GCE 常驻中枢与微信单持有者舰队桥接 / Wave P1 零填表冷启动、ACP 编码军团与隐藏快照防呆 / Wave P2 合盖离线韧性、微信 3 秒转发参谋与端-边联邦标杆武器包)",
);
