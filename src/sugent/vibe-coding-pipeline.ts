import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ArtifactComprehensionResult } from "./antigravity-artifacts.js";
import type { CausalLedger } from "./causal-ledger.js";
import { assertSafeDeliveryCommandVector } from "./delivery.js";
import {
  HandoffFileBridge,
  type InboundAttachmentInput,
  type OutboundDeliverable,
  type StagedInboundFile,
  type VibeIngressChannel,
} from "./handoff-file-bridge.js";
import type { SuspendedRoundStore } from "./receipt-protocol.js";
import {
  ensureVibeWorkerSkill,
  GitWorktreeManager,
  type CodingHarnessRegistry,
  type RepoBindingRecord,
  type RepoBindingRegistry,
} from "./repo-binding.js";
import { runPreflightSmokeCheck, type PostBootNotice, type RelaunchMode, type SafeRelaunchCoordinator } from "./safe-relauncher.js";
import type { StewardshipLedger } from "./stewardship-ledger.js";
import type { PersonalTrigger } from "./types.js";

export type VibePipelineStage =
  | "clarifying"
  | "planning"
  | "awaiting_plan_approval"
  | "developing"
  | "verifying"
  | "packaging"
  | "awaiting_restart_approval"
  | "relaunching"
  | "completed"
  | "rolled_back"
  | "cancelled"
  | "failed";

export type PackagingTier = "L0_verify_only" | "L1_extension_hotplug" | "L2_source_reload" | "L3_blue_green_app";

export interface VibeVerificationResult {
  passed: boolean;
  ranAtIso: string;
  checks: Array<{ name: string; exitCode: number; passed: boolean; outputTail: string }>;
  smokePngPath?: string;
}

export interface VibePipelineRecord {
  pipelineId: string;
  bindingId: string;
  repoAlias: string;
  projectKey: string;
  channel: VibeIngressChannel;
  peerId?: string;
  requirementText: string;
  stage: VibePipelineStage;
  worktreePath: string;
  branchName?: string;
  isolatedWorktree: boolean;
  conversationId?: string;
  currentRoundId: string;
  suspendedRoundId?: string;
  hopCount: number;
  verifyRetryCount: number;
  maxVerifyRetries: number;
  planSummaryLines?: [string, string, string];
  stagedInboundFiles: StagedInboundFile[];
  outboundDeliverables: OutboundDeliverable[];
  lastVerification?: VibeVerificationResult;
  packagingTier?: PackagingTier;
  stagingArtifactPath?: string;
  errorMessage?: string;
  createdAtIso: string;
  updatedAtIso: string;
}
export type CommandExecPort = (
  argv: readonly string[],
  cwd: string,
  extraEnv?: Record<string, string>,
) => Promise<{ exitCode: number; outputTail: string }>;

function writeJsonAtomic600(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, filePath);
}

export const defaultCommandExecPort: CommandExecPort = (argv, cwd, extraEnv) => {
  const safeArgv = assertSafeDeliveryCommandVector(argv);
  return new Promise((resolve) => {
    execFile(
      safeArgv[0],
      safeArgv.slice(1),
      { cwd: path.resolve(cwd), timeout: 120_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...(extraEnv ?? {}) } },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === "number" ? Number((err as { code: number }).code) : err ? 1 : 0;
        resolve({ exitCode: code, outputTail: `${stdout ?? ""}\n${stderr ?? ""}`.trim().slice(-1200) });
      },
    );
  });
};

export function classifyPackagingTier(changedFiles: readonly string[], binding: RepoBindingRecord): PackagingTier {
  const normalized = changedFiles.map((f) => f.replace(/\\/g, "/"));
  if (
    normalized.length > 0 &&
    normalized.every((f) => /^(?:\.agents\/skills\/|skills\/|dsh-runtime\/plugins\/|plugins\/sugent-ext-)/.test(f))
  ) {
    return "L1_extension_hotplug";
  }
  if (binding.restartMode === "blue_green_app") return "L3_blue_green_app";
  if (binding.restartMode === "process_reload") return "L2_source_reload";
  return "L0_verify_only";
}

export class IndependentGateRunner {
  constructor(private readonly execPort?: CommandExecPort) {}

  async run(input: {
    binding: RepoBindingRecord;
    worktreePath: string;
    outboxDir: string;
    nowIso: string;
  }): Promise<VibeVerificationResult> {
    const checks: VibeVerificationResult["checks"] = [];
    const runner = this.execPort ?? defaultCommandExecPort;
    if (input.binding.verifyArgv?.length) {
      const res = await runner(input.binding.verifyArgv, input.worktreePath);
      checks.push({ name: input.binding.verifyArgv.join(" "), exitCode: res.exitCode, passed: res.exitCode === 0, outputTail: res.outputTail });
    }
    let smokePngPath: string | undefined;
    if (input.binding.smokeArgv?.length) {
      const targetPng = path.join(input.outboxDir, "smoke-preview.png");
      if (this.execPort) {
        const res = await this.execPort(input.binding.smokeArgv, input.worktreePath, { AMB_ELECTRON_SMOKE: targetPng });
        const hasPng = fs.existsSync(targetPng) && fs.statSync(targetPng).size > 0;
        if (hasPng) smokePngPath = targetPng;
        checks.push({ name: input.binding.smokeArgv.join(" "), exitCode: res.exitCode, passed: res.exitCode === 0, outputTail: res.outputTail });
      } else {
        const smoke = await runPreflightSmokeCheck({ smokeArgv: input.binding.smokeArgv, cwd: input.worktreePath, smokePngPath: targetPng });
        if (smoke.smokePngPath) smokePngPath = smoke.smokePngPath;
        checks.push({ name: input.binding.smokeArgv.join(" "), exitCode: smoke.exitCode, passed: smoke.ok, outputTail: smoke.outputTail });
      }
    }
    if (checks.length === 0) {
      checks.push({ name: "no_gate_configured", exitCode: 0, passed: true, outputTail: "未配置门禁命令，已跳过并默认放行。" });
    }
    return { passed: checks.every((c) => c.passed), ranAtIso: input.nowIso, checks, ...(smokePngPath ? { smokePngPath } : {}) };
  }
}
export interface VibeNotificationEvent {
  pipelineId: string;
  channel: VibeIngressChannel;
  peerId?: string;
  stage: VibePipelineStage;
  text: string;
  inlineMedia: OutboundDeliverable[];
  summaryOnlyBundles: OutboundDeliverable[];
}

export class SocialImVibeAdapter {
  static parseOwnerReply(rawText: string): { action?: "approve" | "revise" | "cancel"; feedback?: string } {
    const trimmed = String(rawText ?? "").trim();
    if (!trimmed) return {};
    if (/^(?:1|批准|同意|通过|开工|放行|重启|确认重启)$/i.test(trimmed)) return { action: "approve" };
    if (/^(?:3|取消|停止|终止|放弃|算了)$/i.test(trimmed)) return { action: "cancel" };
    const rev = trimmed.match(/^(?:2|打回|驳回|修改|改成|补充)[\s:：,，-]*(.*)$/i);
    if (rev) {
      const feedback = String(rev[1] ?? "").trim();
      return { action: "revise", ...(feedback ? { feedback } : {}) };
    }
    return {};
  }

  static formatThreeLineCard(lines: [string, string, string]): string {
    return lines.map((l) => l.trim()).filter(Boolean).join("\n");
  }
}

export interface VibeCodingPipelineOptions {
  dataDir: string;
  bindings: RepoBindingRegistry;
  fileBridge: HandoffFileBridge;
  harnesses: CodingHarnessRegistry;
  ledger: StewardshipLedger;
  suspendedStore: SuspendedRoundStore;
  causalLedger?: CausalLedger;
  relauncher: SafeRelaunchCoordinator;
  worktreeManager?: GitWorktreeManager;
  gateRunner?: IndependentGateRunner;
  commandRunner?: CommandExecPort;
  notifyChannel?: (event: VibeNotificationEvent) => Promise<void> | void;
  nowIso?: () => string;
  maxVerifyRetries?: number;
}

export class VibeCodingPipelineOrchestrator {
  readonly filePath: string;
  private readonly worktrees: GitWorktreeManager;
  private readonly gates: IndependentGateRunner;
  private readonly execCmd: CommandExecPort;
  private readonly nowIsoFn: () => string;
  private readonly maxRetries: number;
  private readonly pipelines = new Map<string, VibePipelineRecord>();

  constructor(private readonly opts: VibeCodingPipelineOptions) {
    this.filePath = path.join(path.resolve(opts.dataDir), "sugent-stewardship", "vibe-pipelines.json");
    this.worktrees = opts.worktreeManager ?? new GitWorktreeManager();
    this.gates = opts.gateRunner ?? new IndependentGateRunner(opts.commandRunner);
    this.execCmd = opts.commandRunner ?? defaultCommandExecPort;
    this.nowIsoFn = opts.nowIso ?? (() => new Date().toISOString());
    this.maxRetries = opts.maxVerifyRetries ?? 2;
    this.load();
  }
  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as { pipelines?: VibePipelineRecord[] };
      for (const rec of parsed.pipelines ?? []) {
        if (rec?.pipelineId) this.pipelines.set(rec.pipelineId, rec);
      }
    } catch {
      // ignore corrupted pipeline cache
    }
  }

  private save(): void {
    writeJsonAtomic600(this.filePath, { pipelines: this.listPipelines().slice(0, 40) });
  }

  listPipelines(): VibePipelineRecord[] {
    return Array.from(this.pipelines.values()).sort((a, b) => b.updatedAtIso.localeCompare(a.updatedAtIso));
  }

  getPipeline(pipelineId?: string): VibePipelineRecord | undefined {
    if (!pipelineId?.trim()) return this.listPipelines()[0];
    return this.pipelines.get(pipelineId.trim());
  }

  findPendingApproval(): VibePipelineRecord | undefined {
    return this.listPipelines().find((p) => p.stage === "awaiting_plan_approval" || p.stage === "awaiting_restart_approval");
  }

  resolveSafeArtifactPath(pipelineId: string, fileName: string): string | undefined {
    const rec = this.pipelines.get(pipelineId);
    if (!rec) return undefined;
    const item = rec.outboundDeliverables.find((d) => d.fileName === path.basename(fileName));
    if (!item || !fs.existsSync(item.absolutePath)) return undefined;
    const realFile = fs.realpathSync(item.absolutePath);
    const realRoot = fs.realpathSync(path.resolve(rec.worktreePath));
    if (realFile === realRoot || realFile.startsWith(`${realRoot}${path.sep}`)) return realFile;
    return undefined;
  }

  private async emitNotice(rec: VibePipelineRecord, lines: [string, string, string], deliverables = rec.outboundDeliverables): Promise<void> {
    if (!this.opts.notifyChannel) return;
    const text = this.opts.fileBridge.redactTextForIm(SocialImVibeAdapter.formatThreeLineCard(lines));
    const inlineMedia = deliverables.filter((d) => d.deliveryMode === "inline_media");
    const summaryOnlyBundles = deliverables.filter((d) => d.deliveryMode === "summary_only_large");
    await this.opts.notifyChannel({
      pipelineId: rec.pipelineId,
      channel: rec.channel,
      ...(rec.peerId ? { peerId: rec.peerId } : {}),
      stage: rec.stage,
      text,
      inlineMedia,
      summaryOnlyBundles,
    });
  }

  private makeTrigger(rec: VibePipelineRecord, text: string): PersonalTrigger {
    return {
      id: `trg-${rec.currentRoundId}`,
      sourceKind: "antigravity",
      sourceInstanceId: "vibe-pipeline",
      threadKey: `vibe:${rec.pipelineId}`,
      senderId: "owner",
      addressedToAgent: true,
      fromAllowedSender: true,
      text,
      createdAt: this.nowIsoFn(),
      hopCount: rec.hopCount,
      originTriggerId: rec.pipelineId,
    };
  }
  async startTask(input: {
    text: string;
    bindingQuery?: string;
    channel?: VibeIngressChannel;
    peerId?: string;
    attachments?: InboundAttachmentInput[];
    pullArchiveQuery?: string;
    allowUnlistedPaths?: boolean;
    useWorktree?: boolean;
    worktreesRootDir?: string;
  }): Promise<{
    ok: boolean;
    needsBindingClarification?: boolean;
    requiresPathApproval?: boolean;
    blockedPaths?: string[];
    message: string;
    pipeline?: VibePipelineRecord;
  }> {
    const channel: VibeIngressChannel = input.channel ?? "sugent_app";
    const bindings = this.opts.bindings.listBindings();
    const binding =
      this.opts.bindings.getBinding(input.bindingQuery) ??
      bindings.find((b) => [b.alias, path.basename(b.repoRoot), ...b.keywords].some((k) => k && input.text.toLowerCase().includes(k.toLowerCase()))) ??
      (bindings.length === 1 ? bindings[0] : undefined);
    if (!binding) {
      return {
        ok: false,
        needsBindingClarification: true,
        message: bindings.length === 0
          ? "当前还没有绑定任何本地代码仓。请先告诉我仓库目录路径，或在看板点击「一键绑定 Sugent 自身仓库」。"
          : `本机已绑定多个代码仓（${bindings.map((b) => b.alias).join(" / ")}），请说明这次要改哪一个。`,
      };
    }
    const harness = this.opts.harnesses.get(binding.codingBackend);
    if (!harness) {
      return { ok: false, message: `执行后端 ${binding.codingBackend} 尚未注册。` };
    }
    const pipelineId = `vp-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    const roundId = `rnd-${crypto.randomBytes(3).toString("hex")}`;
    const prep = await this.worktrees.prepareWorktree({
      binding,
      taskId: pipelineId,
      ...(input.worktreesRootDir ? { worktreesRootDir: input.worktreesRootDir } : {}),
      ...(input.useWorktree === false ? { useInPlaceWorkspace: true } : {}),
    });
    ensureVibeWorkerSkill(prep.worktreePath);
    const snap = this.opts.ledger.snapshotForCaller("work_project");
    const guardrailHints = [
      ...snap.goals.filter((g) => g.status === "active").map((g) => `目标：${g.title}（${g.northStarCriterion}）`),
      ...snap.guardrails.map((g) => `[${g.kind}] ${g.statement}`),
    ];
    const staged = this.opts.fileBridge.stageInboundRound({
      workspaceRoot: prep.worktreePath,
      roundId,
      channel,
      requirementText: input.text,
      repoAlias: binding.alias,
      guardrailHints,
      attachments: input.attachments,
      pullArchiveQuery: input.pullArchiveQuery,
      allowUnlistedPaths: input.allowUnlistedPaths,
    });
    if (!staged.ok) {
      return { ok: false, requiresPathApproval: true, blockedPaths: staged.blockedPaths, message: staged.message };
    }
    const nowIso = this.nowIsoFn();
    const record: VibePipelineRecord = {
      pipelineId,
      bindingId: binding.bindingId,
      repoAlias: binding.alias,
      projectKey: binding.projectKey,
      channel,
      ...(input.peerId ? { peerId: input.peerId } : {}),
      requirementText: input.text.trim(),
      stage: "planning",
      worktreePath: prep.worktreePath,
      ...(prep.branchName ? { branchName: prep.branchName } : {}),
      isolatedWorktree: prep.isolatedWorktree,
      ...(binding.pinnedConversationId ? { conversationId: binding.pinnedConversationId } : {}),
      currentRoundId: roundId,
      hopCount: 0,
      verifyRetryCount: 0,
      maxVerifyRetries: this.maxRetries,
      stagedInboundFiles: staged.stagedFiles,
      outboundDeliverables: [],
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
    };
    const phase1Prompt = [
      `[Sugent 定制开发任务 ${pipelineId} · Phase 1 仅出计划]`,
      `请先使用 read_file 阅读工作区下的 ${staged.manifestRelativePath} 及附带素材（共 ${staged.stagedFiles.length} 个文件）。`,
      "本轮仅做代码调研与修改计划（写入 implementation_plan.md 或 .sugent-handoff/outbox/" + roundId + "/PLAN.md），完成后请调用 steward_request_owner_approval 或停下等主人拍板，严禁本轮直接改生产代码。",
    ].join("\n");
    const dispatched = await harness.dispatchPhasePrompt({
      workspacePath: prep.worktreePath,
      prompt: phase1Prompt,
      title: `VibePlan: ${binding.alias}`,
      ...(record.conversationId ? { conversationId: record.conversationId } : {}),
      hopCount: record.hopCount,
    });
    if (dispatched.conversationId) record.conversationId = dispatched.conversationId;
    record.hopCount = dispatched.hopCount;
    if (!dispatched.ok) {
      record.stage = "failed";
      record.errorMessage = dispatched.message ?? dispatched.errorCode ?? "派单失败";
      record.updatedAtIso = this.nowIsoFn();
      this.pipelines.set(pipelineId, record);
      this.save();
      return { ok: false, message: record.errorMessage, pipeline: record };
    }
    this.pipelines.set(pipelineId, record);
    this.save();
    return {
      ok: true,
      message: `已为「${binding.alias}」开辟独立工作区并透传 ${staged.stagedFiles.length} 份附件，研发引擎正在调研出方案。`,
      pipeline: record,
    };
  }

  async onHarnessIdle(pipelineId: string, comprehension?: ArtifactComprehensionResult): Promise<VibePipelineRecord | undefined> {
    const rec = this.pipelines.get(pipelineId);
    if (!rec) return undefined;
    const nowIso = this.nowIsoFn();
    if (rec.stage === "planning") {
      const roundId = `plan-${rec.currentRoundId}`;
      const summaryLines: [string, string, string] =
        comprehension && comprehension.allowed
          ? comprehension.threeLineCard
          : [
              `[1/3] 「${rec.repoAlias}」已完成调研，方案已就绪（任务 ${rec.pipelineId}）。`,
              `[2/3] 工作区：${path.basename(rec.worktreePath)}（透传附件 ${rec.stagedInboundFiles.length} 份）。`,
              `[3/3] 回复「1」批准开工，回复「2 补充要求」打回修改，回复「3」取消。`,
            ];
      this.opts.suspendedStore.suspend({
        roundId,
        sessionId: rec.conversationId ?? rec.pipelineId,
        parentTrigger: this.makeTrigger(rec, rec.requirementText),
        approval: { approvalId: `ap-${rec.pipelineId}`, prompt: summaryLines[0], riskLevel: "medium" },
        suspendedAt: nowIso,
      });
      rec.stage = "awaiting_plan_approval";
      rec.suspendedRoundId = roundId;
      rec.planSummaryLines = summaryLines;
      rec.updatedAtIso = nowIso;
      this.save();
      await this.emitNotice(rec, summaryLines, []);
      return rec;
    }
    if (rec.stage === "developing") {
      return this.runVerificationAndPackage(rec.pipelineId);
    }
    return rec;
  }
  private syncExtensionHotplug(rec: VibePipelineRecord, binding: RepoBindingRecord, changedFiles: readonly string[]): string[] {
    if (!binding.isSelfRepo) return [];
    const extRoot = path.join(path.resolve(this.opts.dataDir), "self-repo", "extensions");
    const synced: string[] = [];
    for (const rel of changedFiles) {
      const cleanRel = rel.replace(/\\/g, "/").replace(/^\/+/, "");
      let destRel: string | undefined;
      if (cleanRel.startsWith("skills/")) destRel = cleanRel;
      else if (cleanRel.startsWith("plugins/sugent-ext-")) destRel = cleanRel;
      else if (cleanRel.startsWith("dsh-runtime/plugins/")) destRel = `plugins/${path.basename(cleanRel)}`;
      if (!destRel) continue;
      const srcFile = path.resolve(rec.worktreePath, cleanRel);
      if (!fs.existsSync(srcFile) || !fs.statSync(srcFile).isFile()) continue;
      const destFile = path.join(extRoot, destRel);
      fs.mkdirSync(path.dirname(destFile), { recursive: true, mode: 0o700 });
      fs.copyFileSync(srcFile, destFile);
      synced.push(destFile);
    }
    return synced;
  }

  async runVerificationAndPackage(
    pipelineId: string,
    opts?: { extraArtifactPaths?: string[]; changedFilesOverride?: string[] },
  ): Promise<VibePipelineRecord | undefined> {
    const rec = this.pipelines.get(pipelineId);
    const binding = rec ? this.opts.bindings.getBinding(rec.bindingId) : undefined;
    if (!rec || !binding) return undefined;
    const nowIso = this.nowIsoFn();
    rec.stage = "verifying";
    rec.updatedAtIso = nowIso;
    const outboxDir = path.join(rec.worktreePath, ".sugent-handoff", "outbox", rec.currentRoundId);
    fs.mkdirSync(outboxDir, { recursive: true, mode: 0o700 });

    const verRes = await this.gates.run({ binding, worktreePath: rec.worktreePath, outboxDir, nowIso });
    rec.lastVerification = verRes;
    if (!verRes.passed) {
      const failLogs = verRes.checks.filter((c) => !c.passed).map((c) => `[${c.name} exit=${c.exitCode}]\n${c.outputTail}`).join("\n\n");
      const harness = this.opts.harnesses.get(binding.codingBackend);
      if (rec.verifyRetryCount < rec.maxVerifyRetries && harness) {
        rec.verifyRetryCount += 1;
        const retryRoundId = `fix-${crypto.randomBytes(3).toString("hex")}`;
        this.opts.fileBridge.stageInboundRound({
          workspaceRoot: rec.worktreePath,
          roundId: retryRoundId,
          channel: rec.channel,
          requirementText: `修复客观门禁失败项（第 ${rec.verifyRetryCount} 次自愈）`,
          repoAlias: rec.repoAlias,
          attachments: [{ name: "VERIFY_FAILURE.log", dataBuffer: Buffer.from(failLogs, "utf8"), mime: "text/plain" }],
        });
        const fixPrompt = `客观门禁未通过，请用 read_file 查看 .sugent-handoff/inbox/${retryRoundId}/VERIFY_FAILURE.log 修复问题并重新自测。`;
        const dispatched = await harness.dispatchPhasePrompt({
          workspacePath: rec.worktreePath,
          prompt: fixPrompt,
          title: `VibeFix: ${rec.repoAlias}`,
          ...(rec.conversationId ? { conversationId: rec.conversationId } : {}),
          hopCount: rec.hopCount,
        });
        rec.currentRoundId = retryRoundId;
        rec.hopCount = dispatched.hopCount;
        rec.stage = dispatched.ok ? "developing" : "failed";
        if (!dispatched.ok) rec.errorMessage = dispatched.message ?? "自愈派单失败";
        rec.updatedAtIso = this.nowIsoFn();
        this.save();
        if (!dispatched.ok) await this.emitNotice(rec, [`[1/3] 「${rec.repoAlias}」门禁自愈中断。`, `[2/3] 原因：${rec.errorMessage}`, `[3/3] 请人工介入检查工作区。`], []);
        return rec;
      }
      rec.stage = "failed";
      rec.errorMessage = "客观门禁连续未通过，已停止自动重试";
      rec.updatedAtIso = this.nowIsoFn();
      this.save();
      await this.emitNotice(rec, [`[1/3] 「${rec.repoAlias}」客观门禁未通过。`, `[2/3] 失败详情：${failLogs.slice(0, 120)}`, `[3/3] 请在桌面端查看日志或重新派单。`], []);
      return rec;
    }
    const changedFiles = opts?.changedFilesOverride ?? (await this.worktrees.listChangedFiles(rec.worktreePath));
    const tier = classifyPackagingTier(changedFiles, binding);
    rec.packagingTier = tier;
    rec.stage = "packaging";
    rec.updatedAtIso = this.nowIsoFn();

    if (tier !== "L1_extension_hotplug" && binding.buildArgv?.length) {
      const bRes = await this.execCmd(binding.buildArgv, rec.worktreePath);
      if (bRes.exitCode !== 0) {
        rec.stage = "failed";
        rec.errorMessage = `编译构建失败: ${bRes.outputTail.slice(0, 200)}`;
        this.save();
        await this.emitNotice(rec, [`[1/3] 「${rec.repoAlias}」编译失败。`, `[2/3] ${rec.errorMessage}`, `[3/3] 请检查桌面端构建日志。`], []);
        return rec;
      }
    }
    if (tier === "L3_blue_green_app" && binding.packageArgv?.length) {
      const pRes = await this.execCmd(binding.packageArgv, rec.worktreePath);
      if (pRes.exitCode !== 0) {
        rec.stage = "failed";
        rec.errorMessage = `应用打包失败: ${pRes.outputTail.slice(0, 200)}`;
        this.save();
        await this.emitNotice(rec, [`[1/3] 「${rec.repoAlias}」打包失败。`, `[2/3] ${rec.errorMessage}`, `[3/3] 原运行包未受任何影响。`], []);
        return rec;
      }
    }
    if (binding.stagingAppRelPath) {
      const candidate = path.resolve(rec.worktreePath, binding.stagingAppRelPath);
      if (fs.existsSync(candidate)) rec.stagingArtifactPath = candidate;
    }

    const extraPaths = [
      ...(opts?.extraArtifactPaths ?? []),
      ...(verRes.smokePngPath ? [verRes.smokePngPath] : []),
      ...(rec.stagingArtifactPath && fs.existsSync(rec.stagingArtifactPath) && fs.statSync(rec.stagingArtifactPath).isFile() ? [rec.stagingArtifactPath] : []),
    ];
    const collected = this.opts.fileBridge.collectOutboundRound({
      workspaceRoot: rec.worktreePath,
      roundId: rec.currentRoundId,
      channel: rec.channel,
      extraArtifactPaths: extraPaths,
    });
    rec.outboundDeliverables = collected.deliverables;

    if (tier === "L1_extension_hotplug" || tier === "L0_verify_only") {
      if (tier === "L1_extension_hotplug") this.syncExtensionHotplug(rec, binding, changedFiles);
      rec.stage = "completed";
      rec.updatedAtIso = this.nowIsoFn();
      this.save();
      const label = tier === "L1_extension_hotplug" ? "L1 技能/插件热插拔生效（免重启）" : "客观门禁验证全部通过";
      await this.emitNotice(rec, [`[1/3] 「${rec.repoAlias}」定制开发已完成。`, `[2/3] 生效层级：${label}；产物 ${rec.outboundDeliverables.length} 份。`, `[3/3] 已将关键验证产物回传当前通道。`]);
      return rec;
    }

    const restartRoundId = `rst-${rec.currentRoundId}`;
    this.opts.suspendedStore.suspend({
      roundId: restartRoundId,
      sessionId: rec.conversationId ?? rec.pipelineId,
      parentTrigger: this.makeTrigger(rec, rec.requirementText),
      approval: { approvalId: `ap-rst-${rec.pipelineId}`, prompt: "新版本构建与冒烟通过，等待确认重启", riskLevel: "high" },
      suspendedAt: this.nowIsoFn(),
    });
    rec.stage = "awaiting_restart_approval";
    rec.suspendedRoundId = restartRoundId;
    rec.updatedAtIso = this.nowIsoFn();
    this.save();
    await this.emitNotice(rec, [`[1/3] 「${rec.repoAlias}」新版本已通过门禁并就绪（${tier}）。`, `[2/3] 验收产物 ${rec.outboundDeliverables.length} 份已就位，支持 30 秒看门狗回滚。`, `[3/3] 回复「1」执行蓝绿安全重启，回复「3」暂不重启。`]);
    return rec;
  }
  private safeResumeRound(roundId: string | undefined, decision: { approved: boolean; decidedBy: string; note?: string }): void {
    if (!roundId) return;
    const existing = this.opts.suspendedStore.get(roundId);
    if (existing && existing.status === "suspended") {
      this.opts.suspendedStore.resume(roundId, { ...decision, resumedAt: this.nowIsoFn() });
    }
  }

  async decide(input: {
    pipelineId?: string;
    rawReplyText?: string;
    action?: "approve" | "revise" | "cancel" | "verify_now" | "relaunch_now";
    feedback?: string;
    launchCommand?: string;
    launchArgs?: string[];
    dryRunRelaunch?: boolean;
  }): Promise<{ ok: boolean; message: string; pipeline?: VibePipelineRecord }> {
    const parsed = input.action ? { action: input.action, feedback: input.feedback } : SocialImVibeAdapter.parseOwnerReply(input.rawReplyText ?? "");
    const rec = input.pipelineId ? this.getPipeline(input.pipelineId) : this.findPendingApproval();
    if (!rec) return { ok: false, message: "当前没有找到待拍板的定制开发任务。" };
    const binding = this.opts.bindings.getBinding(rec.bindingId);
    const harness = binding ? this.opts.harnesses.get(binding.codingBackend) : undefined;
    if (!parsed.action) return { ok: false, message: "请回复「1」批准、「2 补充要求」修改方案，或「3」取消。", pipeline: rec };

    if (parsed.action === "cancel") {
      this.safeResumeRound(rec.suspendedRoundId, { approved: false, decidedBy: "owner", note: "cancelled" });
      rec.stage = "cancelled";
      rec.suspendedRoundId = undefined;
      rec.updatedAtIso = this.nowIsoFn();
      this.save();
      return { ok: true, message: `已取消「${rec.repoAlias}」的定制开发任务。`, pipeline: rec };
    }
    if (parsed.action === "verify_now") {
      const updated = await this.runVerificationAndPackage(rec.pipelineId);
      return { ok: Boolean(updated), message: updated?.stage === "failed" ? updated.errorMessage ?? "验证未通过" : "已完成客观门禁复核。", pipeline: updated };
    }
    if (rec.stage === "awaiting_plan_approval" && harness) {
      if (parsed.action === "approve") {
        this.safeResumeRound(rec.suspendedRoundId, { approved: true, decidedBy: "owner" });
        const prompt = `[Phase 2 已批准开工 · 任务 ${rec.pipelineId}]\n请按既定计划在当前隔离工作区实施改动并跑单测；完成后把验收截图或产物放入 .sugent-handoff/outbox/${rec.currentRoundId}/ 并调用 steward_report_milestone。`;
        const res = await harness.dispatchPhasePrompt({ workspacePath: rec.worktreePath, prompt, title: `VibeDev: ${rec.repoAlias}`, ...(rec.conversationId ? { conversationId: rec.conversationId } : {}), hopCount: rec.hopCount });
        rec.hopCount = res.hopCount;
        rec.stage = res.ok ? "developing" : "failed";
        if (!res.ok) rec.errorMessage = res.message ?? "开工派单失败";
        rec.suspendedRoundId = undefined;
        rec.updatedAtIso = this.nowIsoFn();
        this.save();
        return { ok: res.ok, message: res.ok ? `已批准「${rec.repoAlias}」方案，研发引擎正在编码实现。` : (rec.errorMessage ?? "开工失败"), pipeline: rec };
      }
      if (parsed.action === "revise") {
        const fb = parsed.feedback?.trim() || "请补充更细致的改动范围与回滚方案";
        this.safeResumeRound(rec.suspendedRoundId, { approved: false, decidedBy: "owner", note: fb });
        const revRoundId = `rev-${crypto.randomBytes(3).toString("hex")}`;
        this.opts.fileBridge.stageInboundRound({ workspaceRoot: rec.worktreePath, roundId: revRoundId, channel: rec.channel, requirementText: `方案修改意见：${fb}`, repoAlias: rec.repoAlias });
        const prompt = `[方案修改意见 · 轮次 ${revRoundId}]\n主人驳回原方案并补充要求：${fb}\n请更新 .sugent-handoff/inbox/${revRoundId}/SPEC_MANIFEST.md 对应的方案并重新申请拍板。`;
        const res = await harness.dispatchPhasePrompt({ workspacePath: rec.worktreePath, prompt, title: `VibePlanRev: ${rec.repoAlias}`, ...(rec.conversationId ? { conversationId: rec.conversationId } : {}), hopCount: rec.hopCount });
        rec.currentRoundId = revRoundId;
        rec.hopCount = res.hopCount;
        rec.stage = res.ok ? "planning" : "failed";
        rec.suspendedRoundId = undefined;
        rec.updatedAtIso = this.nowIsoFn();
        this.save();
        return { ok: res.ok, message: res.ok ? `已将修改意见发回「${rec.repoAlias}」原会话重拟方案。` : "打回方案派单失败", pipeline: rec };
      }
    }
    if (rec.stage === "awaiting_restart_approval" && (parsed.action === "approve" || parsed.action === "relaunch_now")) {
      this.safeResumeRound(rec.suspendedRoundId, { approved: true, decidedBy: "owner" });
      const mode: RelaunchMode = rec.packagingTier === "L3_blue_green_app" ? "blue_green_app" : "process_reload";
      const defaultEntry = path.join(rec.worktreePath, "dist", "src", "main.js");
      this.opts.relauncher.stageAndTriggerRelaunch({
        pipelineId: rec.pipelineId,
        mode,
        ...(binding?.targetAppBundlePath ? { targetAppPath: binding.targetAppBundlePath } : {}),
        ...(rec.stagingArtifactPath ? { stagingAppPath: rec.stagingArtifactPath } : {}),
        launchCommand: input.launchCommand ?? process.execPath,
        launchArgs: input.launchArgs ?? (fs.existsSync(defaultEntry) ? [defaultEntry] : process.argv.slice(1)),
        cwd: rec.worktreePath,
        oldPid: process.pid,
        dryRunNoSpawn: input.dryRunRelaunch,
      });
      rec.stage = "relaunching";
      rec.suspendedRoundId = undefined;
      rec.updatedAtIso = this.nowIsoFn();
      this.save();
      return { ok: true, message: `已启动「${rec.repoAlias}」蓝绿安全重启看门狗（30s 内未健康上线将自动回滚）。`, pipeline: rec };
    }
    return { ok: false, message: `当前任务处于「${rec.stage}」阶段，暂不支持「${parsed.action}」动作。`, pipeline: rec };
  }

  async reconcileBootOutcome(notice: PostBootNotice): Promise<VibePipelineRecord | undefined> {
    const rec = this.pipelines.get(notice.pipelineId);
    if (!rec) return undefined;
    rec.stage = notice.status === "succeeded" ? "completed" : notice.status === "rolled_back" ? "rolled_back" : "failed";
    if (notice.rollbackReason) rec.errorMessage = notice.rollbackReason;
    rec.updatedAtIso = this.nowIsoFn();
    this.save();
    await this.emitNotice(
      rec,
      [
        `[1/3] 「${rec.repoAlias}」${notice.status === "succeeded" ? "新版本上线成功" : "已触发安全回滚"}。`,
        `[2/3] ${notice.summary}`,
        `[3/3] 事务编号：${notice.txId}。`,
      ],
      [],
    );
    return rec;
  }
}
