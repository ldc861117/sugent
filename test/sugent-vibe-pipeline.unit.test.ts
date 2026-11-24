import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import {
  AntigravityCodingHarness,
  AntigravityDispatcher,
  CausalLedger,
  CodingHarnessRegistry,
  HandoffFileBridge,
  IndependentGateRunner,
  LocalBudgetLedger,
  RepoBindingRegistry,
  SafeRelaunchCoordinator,
  StewardshipLedger,
  SugentKnowledgeGraph,
  SuspendedRoundStore,
  VibeCodingPipelineOrchestrator,
  type VibeNotificationEvent,
} from "../src/sugent/index.js";

describe("VibeCodingPipelineOrchestrator & Multi-IM / Desktop API", () => {
  const dirs: string[] = [];
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
    while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  const makeTmp = (prefix: string) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(d);
    return d;
  };

  it("executes 8-stage vibe pipeline: revise plan, approve, auto-heal gate, hotplug L1 & blue-green L3", async () => {
    const dataDir = makeTmp("sugent-vp-data-");
    const repoDir = makeTmp("sugent-vp-repo-");
    fs.mkdirSync(path.join(repoDir, "skills", "demo"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "skills", "demo", "SKILL.md"), "# Demo Skill\n");

    const prompts: string[] = [];
    const dispatcher = new AntigravityDispatcher({
      runner: {
        async getConversationMetadata() { return { exists: true, nestingDepth: 0, workspaceUris: [repoDir] }; },
        async sendMessage(p) { prompts.push(p.content); return { ok: true, exitCode: 0 }; },
        async newConversation(p) { prompts.push(p.prompt); return { conversationId: "22222222-2222-2222-2222-222222222222", exitCode: 0 }; },
      },
    });
    const bindings = new RepoBindingRegistry({ dataDir });
    const selfRepo = bindings.upsertBinding({
      bindingId: "repo-sugent-self",
      alias: "Sugent 自身源码",
      repoRoot: repoDir,
      verifyArgv: ["npm", "run", "verify:sugent"],
      smokeArgv: ["npm", "run", "electron:smoke"],
      packageArgv: ["npx", "electron-builder"],
      stagingAppRelPath: "release/Sugent.app",
      targetAppBundlePath: path.join(dataDir, "Apps", "Sugent.app"),
      restartMode: "blue_green_app",
      isSelfRepo: true,
    });
    const kg = new SugentKnowledgeGraph(path.join(dataDir, "kg"));
    const ledger = new StewardshipLedger({ dataDir, knowledgeGraph: kg, budgetLedger: new LocalBudgetLedger(dataDir) });
    const suspendedStore = new SuspendedRoundStore(path.join(dataDir, "sugent-stewardship"));
    const fileBridge = new HandoffFileBridge({ dataDir, ledger });
    const harnesses = new CodingHarnessRegistry([new AntigravityCodingHarness(dispatcher)]);
    const relauncher = new SafeRelaunchCoordinator({ dataDir });
    let gateAttempts = 0;
    const notices: VibeNotificationEvent[] = [];
    const gateRunner = new IndependentGateRunner(async (argv, _cwd, env) => {
      if (argv[2] === "electron:smoke" && env?.AMB_ELECTRON_SMOKE) {
        fs.writeFileSync(env.AMB_ELECTRON_SMOKE, Buffer.from("PNG_SMOKE"));
        return { exitCode: 0, outputTail: "SMOKE OK" };
      }
      gateAttempts += 1;
      return gateAttempts === 1 ? { exitCode: 1, outputTail: "TypeError: broken" } : { exitCode: 0, outputTail: "ALL GREEN" };
    });
    const orch = new VibeCodingPipelineOrchestrator({
      dataDir,
      bindings,
      fileBridge,
      harnesses,
      ledger,
      suspendedStore,
      causalLedger: new CausalLedger(path.join(dataDir, "sugent-stewardship")),
      relauncher,
      gateRunner,
      commandRunner: async (argv, cwd) => {
        if (argv[0] === "npx") fs.mkdirSync(path.join(cwd, "release", "Sugent.app"), { recursive: true });
        return { exitCode: 0, outputTail: "ok" };
      },
      notifyChannel: (ev) => { notices.push(ev); },
    });

    const start = await orch.startTask({
      text: "把侧栏改成可折叠",
      bindingQuery: selfRepo.bindingId,
      channel: "dingtalk",
      attachments: [{ name: "ui.png", dataBuffer: Buffer.from("png-ref"), mime: "image/png" }],
      useWorktree: false,
    });
    expect(start.ok).toBe(true);
    const pid = start.pipeline!.pipelineId;
    await orch.onHarnessIdle(pid);
    expect(orch.getPipeline(pid)?.stage).toBe("awaiting_plan_approval");

    const rev = await orch.decide({ pipelineId: pid, rawReplyText: "2 补充深色模式支持" });
    expect(rev.ok).toBe(true);
    expect(orch.getPipeline(pid)?.stage).toBe("planning");
    await orch.onHarnessIdle(pid);
    const appRes = await orch.decide({ pipelineId: pid, rawReplyText: "1" });
    expect(appRes.pipeline?.stage).toBe("developing");

    const failPass = await orch.runVerificationAndPackage(pid, { changedFilesOverride: ["src/sugent/ui.ts"] });
    expect(failPass?.verifyRetryCount).toBe(1);
    expect(failPass?.stage).toBe("developing");
    expect(prompts.at(-1)).toContain("VERIFY_FAILURE.log");

    const l1Res = await orch.runVerificationAndPackage(pid, { changedFilesOverride: ["skills/demo/SKILL.md"] });
    expect(l1Res?.stage).toBe("completed");
    expect(l1Res?.packagingTier).toBe("L1_extension_hotplug");
    expect(fs.existsSync(path.join(dataDir, "self-repo", "extensions", "skills", "demo", "SKILL.md"))).toBe(true);

    l1Res!.stage = "developing";
    const l3Res = await orch.runVerificationAndPackage(pid, { changedFilesOverride: ["electron/main.ts"] });
    expect(l3Res?.stage).toBe("awaiting_restart_approval");
    expect(l3Res?.outboundDeliverables.some((d) => d.fileName === "smoke-preview.png")).toBe(true);
    const rel = await orch.decide({ pipelineId: pid, rawReplyText: "1", dryRunRelaunch: true });
    expect(rel.pipeline?.stage).toBe("relaunching");
    expect(relauncher.readTransaction()?.mode).toBe("blue_green_app");
    expect(notices.some((n) => n.channel === "dingtalk")).toBe(true);
  });

  it("handles /amb/api/steward/repos & /vibe/* routes and natural language converse approval", async () => {
    const dataDir = makeTmp("sugent-vapi-data-");
    const repoDir = makeTmp("sugent-vapi-repo-");
    const cfg = loadConfig({ dataDir, env: { AMB_UI_PORT: "0", AMB_AGENT: "off", AMB_MAGPIE_BASE_URL: "http://127.0.0.1:43199/v1" } });
    const app = new App(cfg, { printQrToTerminal: false, fileLog: false, stewardHomeDir: dataDir });
    await app.start();
    cleanups.push(() => app.stop());

    app.stewardService.codingHarnesses.register({
      backend: "antigravity",
      async dispatchPhasePrompt() { return { ok: true, roundId: "r-mock", hopCount: 1, maxHops: 8, conversationId: "conv-vibe-api" }; },
    });

    const callApi = async (pathname: string, method = "GET", body?: unknown) => {
      const res = await app.web!.inject(`/amb/api${pathname}`, {
        method,
        headers: body !== undefined ? { "content-type": "application/json" } : {},
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: res.text ? JSON.parse(res.text) : {} };
    };

    const bindRes = await callApi("/steward/repos", "POST", { alias: "CRM前端", repoRoot: repoDir, verifyArgv: [], restartMode: "none" });
    expect(bindRes.status).toBe(200);
    expect(bindRes.json.binding.alias).toBe("CRM前端");

    const startRes = await callApi("/steward/vibe/start", "POST", {
      bindingQuery: bindRes.json.binding.bindingId,
      text: "优化表格分页",
      channel: "sugent_app",
      useWorktree: false,
      attachments: [{ name: "mock.png", dataBase64: Buffer.from("PNG_DATA").toString("base64"), mime: "image/png" }],
    });
    expect(startRes.json.ok).toBe(true);
    const pid = startRes.json.pipeline.pipelineId;

    const adv1 = await callApi("/steward/vibe/advance", "POST", { pipelineId: pid });
    expect(adv1.json.pipeline.stage).toBe("awaiting_plan_approval");

    const convApprove = await app.stewardService.converse({ text: "1", channel: "weixin" });
    expect(convApprove.intent).toBe("vibe_decide");

    const outDir = path.join(repoDir, ".sugent-handoff", "outbox", adv1.json.pipeline.currentRoundId);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "result.png"), Buffer.from("RESULT_PNG"));

    const adv2 = await callApi("/steward/vibe/advance", "POST", { pipelineId: pid });
    expect(adv2.json.pipeline.stage).toBe("completed");

    const artRes = await callApi(`/steward/vibe/artifact?pipelineId=${encodeURIComponent(pid)}&file=result.png&format=json`);
    expect(artRes.status).toBe(200);
    expect(Buffer.from(artRes.json.dataBase64, "base64").toString("utf8")).toBe("RESULT_PNG");
  });

  it("records full Vibe pipeline lifecycle into unified CausalLedger for sugent:why and migrates legacy sugent-ledger", async () => {
    const { resolveUnifiedCausalLedgerDir } = await import("../src/sugent/causal-ledger.js");
    const { parseWhyCliArgs } = await import("../src/cli/why.js");
    const dataDir = makeTmp("sugent-vp-why-");
    const repoDir = makeTmp("sugent-vp-why-repo-");
    fs.mkdirSync(path.join(repoDir, "skills", "demo"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "skills", "demo", "SKILL.md"), "# Demo\n");

    const legacyLedger = new CausalLedger(path.join(dataDir, "sugent-ledger"));
    legacyLedger.append({
      roundId: "legacy-round-1",
      kind: "round_triggered",
      at: "2026-11-20T08:00:00.000Z",
      title: "历史巡检任务",
      source: "schedule",
    });

    const unifiedDir = resolveUnifiedCausalLedgerDir(dataDir);
    expect(unifiedDir).toBe(path.join(dataDir, "sugent-stewardship"));
    const causalLedger = new CausalLedger(unifiedDir);
    expect(causalLedger.traceRound("legacy-round-1")?.title).toBe("历史巡检任务");
    expect(parseWhyCliArgs([], { ...process.env, AMB_DATA_DIR: dataDir }).ledgerDir).toContain("sugent-stewardship");

    const dispatcher = new AntigravityDispatcher({
      runner: {
        async getConversationMetadata() { return { exists: true, nestingDepth: 0, workspaceUris: [repoDir] }; },
        async sendMessage() { return { ok: true, exitCode: 0 }; },
        async newConversation() { return { conversationId: "33333333-3333-3333-3333-333333333333", exitCode: 0 }; },
      },
    });
    const bindings = new RepoBindingRegistry({ dataDir });
    const bound = bindings.upsertBinding({
      bindingId: "repo-why-test",
      alias: "Why测试仓",
      repoRoot: repoDir,
      verifyArgv: [],
      restartMode: "extension_hotplug",
      isSelfRepo: true,
    });
    const kg = new SugentKnowledgeGraph(path.join(dataDir, "kg"));
    const ledger = new StewardshipLedger({ dataDir, knowledgeGraph: kg, budgetLedger: new LocalBudgetLedger(dataDir) });
    const suspendedStore = new SuspendedRoundStore(unifiedDir);
    const fileBridge = new HandoffFileBridge({ dataDir, ledger });
    const harnesses = new CodingHarnessRegistry([new AntigravityCodingHarness(dispatcher)]);
    const relauncher = new SafeRelaunchCoordinator({ dataDir });
    const orch = new VibeCodingPipelineOrchestrator({
      dataDir,
      bindings,
      fileBridge,
      harnesses,
      ledger,
      suspendedStore,
      causalLedger,
      relauncher,
      gateRunner: new IndependentGateRunner(async () => ({ exitCode: 0, outputTail: "OK" })),
    });

    const started = await orch.startTask({
      text: "新增演示技能",
      bindingQuery: bound.bindingId,
      channel: "weixin",
      useWorktree: false,
    });
    const pid = started.pipeline!.pipelineId;
    await orch.onHarnessIdle(pid);
    await orch.decide({ pipelineId: pid, rawReplyText: "1" });
    const done = await orch.runVerificationAndPackage(pid, { changedFilesOverride: ["skills/demo/SKILL.md"] });
    expect(done?.stage).toBe("completed");

    const trace = causalLedger.traceRound(pid);
    expect(trace).toBeDefined();
    expect(trace!.facts.map((f) => f.kind)).toEqual(
      expect.arrayContaining(["round_triggered", "approval_requested", "approval_decided", "round_completed"]),
    );
    const whyText = causalLedger.explainWhy(pid);
    expect(whyText).toContain("Why测试仓");
    expect(whyText).toContain("挂起拍板");
    expect(whyText).toContain("批准");
  });
});