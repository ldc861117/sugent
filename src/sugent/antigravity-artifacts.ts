import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AntigravitySurface, PrivacyTier, ProjectPrivacyRegistry } from "./antigravity-bridge.js";
import { selectModelForRole, resolveSugentGatewayConfig } from "./gateway.js";
import type { SuspendedRoundStore } from "./receipt-protocol.js";
import { sealExternalEvent } from "./security-envelope.js";
import type {
  CallerAccessDomain,
  GoalNorthStar,
  StewardshipLedger,
  ValueGuardrail,
} from "./stewardship-ledger.js";
import type { EventSecurityEnvelope, PersonalTrigger, SugentGatewayConfig } from "./types.js";

export interface ArtifactComprehensionInput {
  conversationId: string;
  projectKey: string;
  projectDisplayName?: string;
  workspaceRoot?: string;
  callerDomain?: CallerAccessDomain;
  surface?: AntigravitySurface;
  title?: string;
  isRunning?: boolean;
  notFullyIdle?: boolean;
  stepCount?: number;
  lastUserInputStepIndex?: number;
  activeSubagentCount?: number;
  activeChildConversationIds?: string[];
  nowIso?: string;
  hopCount?: number;
}

export interface LiveExecutionPulse {
  isRunning: boolean;
  stepCount: number;
  stepsSinceUserInput?: number;
  activeSubagentCount: number;
  runningTaskSnippets: string[];
  latestPlannerText?: string;
  activeChildActivities: string[];
  taskChecklist?: { done: number; inProgress: string[]; todo: string[] };
}

export type ComprehensionModelPort = (ctx: {
  sealedPrompt: string;
  referenceFilePath: string;
  artifactSummaryRaw: string;
  activeGoals: GoalNorthStar[];
  guardrails: ValueGuardrail[];
  model: string;
}) => Promise<{
  goalAlignmentLine: string;
  riskAndVerificationLine: string;
  decisionPromptLine: string;
  requiresApproval: boolean;
}>;

export interface ArtifactComprehensionPipelineOptions {
  homeDir?: string;
  sealWorkspaceDir: string;
  privacyRegistry: ProjectPrivacyRegistry;
  ledger: StewardshipLedger;
  getGatewayConfig?: () => SugentGatewayConfig;
  suspendedStore?: SuspendedRoundStore;
  comprehensionModelPort?: ComprehensionModelPort;
}

export type ArtifactComprehensionResult =
  | { allowed: false; reason: string; tier: PrivacyTier; tierEpoch: number }
  | {
      allowed: true;
      ok: true;
      conversationId: string;
      projectKey: string;
      projectDisplayName: string;
      runState: "running" | "idle";
      livePulse: LiveExecutionPulse;
      selectedModel: string;
      envelope: EventSecurityEnvelope;
      sealedPrompt: string;
      artifactsFound: string[];
      artifactFilePaths?: string[];
      threeLineCard: [string, string, string];
      requiresApproval: boolean;
      suspendedRoundId?: string;
      artifactExcerpt: string;
    };

interface TranscriptTailInfo {
  latestPlannerText?: string;
  runningTaskSnippets: string[];
  latestStepIndex?: number;
  latestCreatedAt?: string;
  latestToolNames: string[];
}

function readTranscriptTailInfo(brainDir: string, maxLines = 30): TranscriptTailInfo {
  const transcriptPath = path.join(brainDir, ".system_generated", "logs", "transcript.jsonl");
  const info: TranscriptTailInfo = { runningTaskSnippets: [], latestToolNames: [] };
  if (!fs.existsSync(transcriptPath)) return info;
  try {
    const lines = fs.readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean).slice(-maxLines);
    for (let i = lines.length - 1; i >= 0; i--) {
      const d = JSON.parse(lines[i]!) as {
        step_index?: unknown;
        type?: unknown;
        status?: unknown;
        created_at?: unknown;
        content?: unknown;
        tool_calls?: Array<{ name?: unknown }>;
      };
      if (info.latestStepIndex === undefined && typeof d.step_index === "number") info.latestStepIndex = d.step_index;
      if (!info.latestCreatedAt && typeof d.created_at === "string") info.latestCreatedAt = d.created_at;
      const content = typeof d.content === "string" ? d.content.trim() : "";
      if (d.status === "RUNNING" && content && info.runningTaskSnippets.length < 3) {
        info.runningTaskSnippets.push(content.replace(/\s+/g, " ").slice(0, 140));
      }
      if (!info.latestPlannerText && d.type === "PLANNER_RESPONSE" && content) {
        info.latestPlannerText = content.slice(0, 1200);
        info.latestToolNames = (d.tool_calls ?? []).map((t) => String(t?.name ?? "")).filter(Boolean).slice(0, 5);
      }
    }
  } catch {
    return info;
  }
  return info;
}

function parseTaskChecklist(brainDir?: string): LiveExecutionPulse["taskChecklist"] {
  if (!brainDir) return undefined;
  const tp = path.join(brainDir, "task.md");
  if (!fs.existsSync(tp)) return undefined;
  try {
    const txt = fs.readFileSync(tp, "utf8");
    const done = (txt.match(/^\s*-\s*\[x\]/gim) ?? []).length;
    const inProgress = Array.from(txt.matchAll(/^\s*-\s*\[\/\]\s*(.+)$/gm), (m) => m[1]!.trim()).slice(0, 3);
    const todo = Array.from(txt.matchAll(/^\s*-\s*\[\s\]\s*(.+)$/gm), (m) => m[1]!.trim()).slice(0, 3);
    return { done, inProgress, todo };
  } catch {
    return undefined;
  }
}

function collectLiveExecutionPulse(
  homeDir: string,
  brainDir: string | undefined,
  rootTail: TranscriptTailInfo,
  input: ArtifactComprehensionInput,
): { pulse: LiveExecutionPulse; pulseMarkdown: string } {
  const stepCount = input.stepCount ?? rootTail.latestStepIndex ?? 0;
  const stepsSinceUserInput =
    typeof input.lastUserInputStepIndex === "number" && input.lastUserInputStepIndex >= 0 && stepCount >= input.lastUserInputStepIndex
      ? stepCount - input.lastUserInputStepIndex
      : undefined;
  const activeChildActivities: string[] = [];
  for (const childId of (input.activeChildConversationIds ?? []).slice(0, 3)) {
    const childDir = findBrainDir(homeDir, childId, input.surface);
    if (!childDir) {
      activeChildActivities.push(`子代理 ${childId.slice(0, 8)} 正在后台运行`);
      continue;
    }
    const cTail = readTranscriptTailInfo(childDir, 10);
    const stepPart = cTail.latestStepIndex !== undefined ? `第 ${cTail.latestStepIndex} 步` : "推进中";
    const snippet = (cTail.latestPlannerText ?? cTail.runningTaskSnippets[0] ?? cTail.latestToolNames.join(", ")).replace(/\s+/g, " ").slice(0, 90);
    activeChildActivities.push(`子代理 ${childId.slice(0, 8)} 已到${stepPart}${snippet ? `：${snippet}` : ""}`);
  }
  const taskChecklist = parseTaskChecklist(brainDir);
  const activeSubagentCount = input.activeSubagentCount ?? activeChildActivities.length;
  const isRunning = Boolean(input.isRunning || rootTail.runningTaskSnippets.length > 0 || activeSubagentCount > 0);
  const pulse: LiveExecutionPulse = {
    isRunning,
    stepCount,
    ...(stepsSinceUserInput !== undefined ? { stepsSinceUserInput } : {}),
    activeSubagentCount,
    runningTaskSnippets: rootTail.runningTaskSnippets,
    ...(rootTail.latestPlannerText ? { latestPlannerText: rootTail.latestPlannerText.replace(/\s+/g, " ").slice(0, 260) } : {}),
    activeChildActivities,
    ...(taskChecklist ? { taskChecklist } : {}),
  };
  const lines = [
    `## live_execution_pulse`,
    `- 运行状态：${isRunning ? "进行中（RUNNING）" : "已停下/空闲（IDLE）"} · 总步数 ${stepCount}${stepsSinceUserInput !== undefined ? `（距最近用户输入推进 ${stepsSinceUserInput} 步）` : ""} · 活跃子代理 ${activeSubagentCount} 个`,
    ...(rootTail.runningTaskSnippets.length ? [`- 主会话当前运行步骤：${rootTail.runningTaskSnippets.join(" | ")}`] : []),
    ...(activeChildActivities.length ? activeChildActivities.map((a) => `- ${a}`) : []),
    ...(taskChecklist ? [`- task.md 进度：已完成 ${taskChecklist.done} 项${taskChecklist.inProgress.length ? `，进行中：${taskChecklist.inProgress.join("；")}` : ""}`] : []),
  ];
  return { pulse, pulseMarkdown: lines.join("\n") };
}
function findBrainDir(homeDir: string, conversationId: string, preferred?: AntigravitySurface): string | undefined {
  const cleanId = path.basename(conversationId.trim());
  if (!cleanId) return undefined;
  const subdirs = new Map<AntigravitySurface, string>([
    ["app", "antigravity"],
    ["cli", "antigravity-cli"],
    ["ide", "antigravity-ide"],
  ]);
  const order: AntigravitySurface[] = preferred
    ? [preferred, ...(["app", "cli", "ide"] as AntigravitySurface[]).filter((s) => s !== preferred)]
    : ["app", "cli", "ide"];
  for (const s of order) {
    const dir = path.join(homeDir, ".gemini", subdirs.get(s)!, "brain", cleanId);
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
  }
  return undefined;
}

function collectBrainArtifacts(
  homeDir: string,
  brainDir: string | undefined,
  input: ArtifactComprehensionInput,
): { artifactsFound: string[]; artifactFilePaths: string[]; combinedMarkdown: string; excerpt: string; pulse: LiveExecutionPulse } {
  const found: string[] = [];
  const artifactFilePaths: string[] = [];
  const rootTail = brainDir ? readTranscriptTailInfo(brainDir, 30) : { runningTaskSnippets: [], latestToolNames: [] };
  const { pulse, pulseMarkdown } = collectLiveExecutionPulse(homeDir, brainDir, rootTail, input);
  const sections: string[] = [pulseMarkdown];
  const candidates = ["implementation_plan.md", "task.md", "walkthrough.md"];

  if (brainDir) {
    try {
      for (const name of fs.readdirSync(brainDir)) {
        if (!name.endsWith(".metadata.json")) continue;
        const meta = JSON.parse(fs.readFileSync(path.join(brainDir, name), "utf8")) as { userFacing?: boolean };
        if (meta.userFacing === true) {
          const baseName = name.slice(0, -".metadata.json".length);
          if (!candidates.includes(baseName)) candidates.push(baseName);
        }
      }
    } catch {
      // ignore metadata parse failures
    }
    for (const fileName of candidates) {
      const fullPath = path.join(brainDir, fileName);
      if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) continue;
      const raw = fs.readFileSync(fullPath, "utf8").trim();
      if (!raw) continue;
      found.push(fileName);
      artifactFilePaths.push(fullPath);
      sections.push(`## ${fileName}\n${raw.slice(0, 4000)}`);
    }
    if (rootTail.latestPlannerText) {
      found.push("transcript_tail");
      sections.push(`## latest_planner_response\n${rootTail.latestPlannerText}`);
    }
  }
  const combinedMarkdown = sections.join("\n\n").trim();
  const excerpt = combinedMarkdown.replace(/[#>`*_]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 2400);
  return { artifactsFound: found, artifactFilePaths, combinedMarkdown, excerpt, pulse };
}

function deterministicSynthesize(params: {
  title: string;
  displayName: string;
  artifactsFound: readonly string[];
  rawText: string;
  pulse: LiveExecutionPulse;
  activeGoals: readonly GoalNorthStar[];
  guardrails: readonly ValueGuardrail[];
}): { goalAlignmentLine: string; riskAndVerificationLine: string; decisionPromptLine: string; requiresApproval: boolean } {
  const goal = params.activeGoals.find((g) => params.rawText.includes(g.title)) ?? params.activeGoals[0];
  const matchedTombstone = params.guardrails.find((gr) => {
    if (gr.kind === "soft_taste") return false;
    const key = gr.statement.slice(0, 8);
    return key.length >= 3 && params.rawText.includes(key);
  });
  if (params.pulse.isRunning) {
    const subHint = params.pulse.activeSubagentCount > 0 ? `，${params.pulse.activeSubagentCount} 个子代理协同推进中` : "";
    const goalAlignmentLine = `项目「${params.displayName}」(${params.title})：正在运行中（第 ${params.pulse.stepCount} 步${subHint}）`;
    const activeSnippet = params.pulse.runningTaskSnippets[0] ?? params.pulse.activeChildActivities[0] ?? params.pulse.latestPlannerText ?? "后台任务持续推进中";
    const riskAndVerificationLine = matchedTombstone
      ? `⚠️ 过程疑似涉及红线「${matchedTombstone.statement}」；当前进度：${activeSnippet.slice(0, 90)}`
      : `当前最新动态：${activeSnippet.slice(0, 110)}`;
    const decisionPromptLine = "当前会话正在后台持续运行中，无需人工放行；可随时等待完工或追问细节。";
    return { goalAlignmentLine, riskAndVerificationLine, decisionPromptLine, requiresApproval: false };
  }
  const requiresApproval = Boolean(matchedTombstone) || params.artifactsFound.includes("implementation_plan.md");
  const goalAlignmentLine = `项目「${params.displayName}」(${params.title})：对齐目标「${goal?.title ?? "常规推进"}」，已读取 ${params.artifactsFound.length} 份制品`;
  const testHint = /(?:pass|passed|通过)/i.test(params.rawText) ? "含测试/验证记录" : "暂未见明确测试回执";
  const riskAndVerificationLine = matchedTombstone
    ? `⚠️ 疑似触及红线「${matchedTombstone.statement}」；${testHint}`
    : `未见红线/墓碑冲突；${testHint}`;
  const decisionPromptLine = requiresApproval
    ? "回复 1 放行继续、回复 2 补充修改意见打回，或回复 3 暂缓"
    : "该轮成果已稳妥落袋，如需继续深挖可直接告诉我";
  return { goalAlignmentLine, riskAndVerificationLine, decisionPromptLine, requiresApproval };
}
export class ArtifactComprehensionPipeline {
  private readonly homeDir: string;

  constructor(private readonly opts: ArtifactComprehensionPipelineOptions) {
    this.homeDir = opts.homeDir ?? os.homedir();
  }

  async comprehendSession(input: ArtifactComprehensionInput): Promise<ArtifactComprehensionResult> {
    const callerDomain = input.callerDomain ?? "owner_private";
    const nowIso = input.nowIso ?? new Date().toISOString();
    const policy = this.opts.privacyRegistry.resolveProjectPolicy({
      projectKey: input.projectKey,
      ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
      title: input.title,
    });

    if (callerDomain !== "owner_private" && policy.tier === 0) {
      return { allowed: false, reason: "tier_0_local_only", tier: policy.tier, tierEpoch: policy.tierEpoch };
    }

    const displayName =
      input.projectDisplayName?.trim() ||
      input.projectKey.replace(/^repo:[^/]+\//, "").replace(/^local:[^:]+:/, "");
    const brainDir = findBrainDir(this.homeDir, input.conversationId, input.surface);
    const collected = collectBrainArtifacts(this.homeDir, brainDir, input);

    const safeText = callerDomain !== "owner_private" && policy.tier === 1
      ? `（该项目处于脱敏摘要档位）运行状态=${collected.pulse.isRunning ? "running" : "idle"}，步数=${collected.pulse.stepCount}，检测到 ${collected.artifactsFound.length} 份本地制品`
      : collected.combinedMarkdown;

    const cleanConvToken = input.conversationId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48) || "session";
    const safeRef = input.projectKey.replace(/[^A-Za-z0-9._:/#@+-]/g, "_").slice(0, 120);
    const sealed = sealExternalEvent({
      workspaceDir: this.opts.sealWorkspaceDir,
      source: "antigravity",
      eventType: "session.artifacts",
      eventId: `agy-${cleanConvToken}`,
      ref: safeRef,
      title: input.title ?? input.conversationId,
      body: safeText,
      payload: {
        conversationId: input.conversationId,
        projectKey: input.projectKey,
        projectDisplayName: displayName,
        runState: collected.pulse.isRunning ? "running" : "idle",
        tier: policy.tier,
        tierEpoch: policy.tierEpoch,
        artifacts: collected.artifactsFound,
      },
      privilegedFieldMode: "strip",
    });

    const gw = this.opts.getGatewayConfig?.() ?? resolveSugentGatewayConfig(undefined, {});
    const selectedModel = selectModelForRole(gw, "steward");
    const snap = this.opts.ledger.snapshotForCaller(callerDomain);
    const activeGoals = snap.goals.filter((g) => g.status === "active");

    const synth = this.opts.comprehensionModelPort
      ? await this.opts.comprehensionModelPort({
          sealedPrompt: sealed.prompt,
          referenceFilePath: sealed.envelope.absoluteFilePath,
          artifactSummaryRaw: safeText,
          activeGoals,
          guardrails: snap.guardrails,
          model: selectedModel,
        })
      : deterministicSynthesize({
          title: input.title ?? input.conversationId.slice(0, 8),
          displayName,
          artifactsFound: collected.artifactsFound,
          rawText: safeText,
          pulse: collected.pulse,
          activeGoals,
          guardrails: snap.guardrails,
        });

    let suspendedRoundId: string | undefined;
    if (synth.requiresApproval && this.opts.suspendedStore) {
      suspendedRoundId = `rnd-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
      const trigger: PersonalTrigger = {
        id: `trg-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`,
        sourceKind: "antigravity",
        sourceInstanceId: "agy-artifacts",
        threadKey: `antigravity:local:${input.surface ?? "app"}:${cleanConvToken}`,
        senderId: "owner",
        addressedToAgent: true,
        fromAllowedSender: true,
        text: synth.goalAlignmentLine,
        createdAt: nowIso,
        hopCount: input.hopCount ?? 0,
      };
      this.opts.suspendedStore.suspend({
        roundId: suspendedRoundId,
        sessionId: input.conversationId,
        parentTrigger: trigger,
        approval: {
          approvalId: `apr-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`,
          prompt: `${synth.goalAlignmentLine}\n${synth.riskAndVerificationLine}\n${synth.decisionPromptLine}`,
          riskLevel: "medium",
        },
        suspendedAt: nowIso,
      });
    }

    const redactedForTier1 = callerDomain !== "owner_private" && policy.tier === 1;
    const exposedPulse: LiveExecutionPulse = redactedForTier1
      ? {
          isRunning: collected.pulse.isRunning,
          stepCount: collected.pulse.stepCount,
          activeSubagentCount: collected.pulse.activeSubagentCount,
          runningTaskSnippets: [],
          activeChildActivities: [],
        }
      : collected.pulse;
    return {
      allowed: true,
      ok: true,
      conversationId: input.conversationId,
      projectKey: input.projectKey,
      projectDisplayName: displayName,
      runState: collected.pulse.isRunning ? "running" : "idle",
      livePulse: exposedPulse,
      selectedModel,
      envelope: sealed.envelope,
      sealedPrompt: sealed.prompt,
      artifactsFound: collected.artifactsFound,
      ...(!redactedForTier1 && collected.artifactFilePaths.length ? { artifactFilePaths: collected.artifactFilePaths } : {}),
      threeLineCard: [synth.goalAlignmentLine, synth.riskAndVerificationLine, synth.decisionPromptLine],
      requiresApproval: synth.requiresApproval,
      ...(suspendedRoundId ? { suspendedRoundId } : {}),
      artifactExcerpt: redactedForTier1 ? safeText : collected.excerpt,
    };
  }
}
