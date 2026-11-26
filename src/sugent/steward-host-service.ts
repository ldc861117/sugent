import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ArtifactComprehensionPipeline,
  type ArtifactComprehensionInput,
  type ArtifactComprehensionResult,
} from "./antigravity-artifacts.js";
import {
  AntigravityStateReader,
  FleetPulseReader,
  ProjectPrivacyRegistry,
  canonicalizeProjectKey,
  type AntigravityScanResult,
  type AntigravitySessionSnapshot,
  type BridgeFleetCadenceEvent,
  type PrivacyTier,
  type ProjectPrivacyPolicy,
  type SanitizedTierPayloadResult,
} from "./antigravity-bridge.js";
import {
  AntigravityDispatcher,
  LocalDiffCanonPublisher,
  PrivacyFilteredOpsProjectionSink,
  type AgentApiRunner,
  type DispatchOutcome,
} from "./antigravity-dispatcher.js";
import { CausalLedger, resolveUnifiedCausalLedgerDir } from "./causal-ledger.js";
import { resolveSugentGatewayConfig, selectModelForRole } from "./gateway.js";
import type { SkillCandidateSummary, SugentKnowledgeGraph } from "./knowledge-graph.js";
import type { BotBudgetStatus, LocalBudgetLedger } from "./local-budget.js";
import {
  createAttentionBudgetGate,
  scanLedgerImbalances,
  type CadenceBudgetState,
  type CadenceBudgetStoragePort,
  type OwnerFlowContext,
  type ProactiveCandidate,
} from "./proactive-cadence.js";
import {
  runGardenerCycle,
  type GardenerCycleInput,
  type GardenerCycleOutput,
} from "./memory-gardener.js";
import { SuspendedRoundStore } from "./receipt-protocol.js";
import {
  StewardshipLedger,
  StewardshipLedgerError,
  type CallerAccessDomain,
  type CommitmentItem,
  type ContextPartition,
  type GoalNorthStar,
  type LedgerSnapshot,
  type RelationshipProfile,
  type TrustTier,
} from "./stewardship-ledger.js";
import type { SugentGatewayConfig } from "./types.js";
import type { ConciergeChannelBridge } from "./concierge-channel-bridge.js";
import {
  StewardConversationEngine,
  type StewardConversationResult,
  type StewardConversationTurnInput,
} from "./steward-conversation.js";
import {
  StewardLlmAgent,
  STEWARD_CAPABILITY_DESCRIPTORS,
  type LocalTaskDelegationInput,
  type LocalTaskDelegationResult,
  type StewardLlmEndpoint,
  type StewardRouteMeta,
} from "./steward-llm-agent.js";
import { SugentStewardMcpServer } from "./steward-mcp.js";
import { CapabilityAwarenessEngine, type CapabilityAwarenessSnapshot } from "./capability-awareness.js";
import { AuthorizedFileReader, type AuthorizedFileMatch, type AuthorizedProjectRoot, type ReadAuthorizedFileResult } from "./authorized-file-reader.js";
import {
  UniversalDropzone,
  type DropzoneChannel,
  type DropzoneOutcome,
} from "./universal-dropzone.js";
import { HandoffFileBridge, type InboundAttachmentInput, type VibeIngressChannel } from "./handoff-file-bridge.js";
import { AcpCodingHarness, DualTrackCodingBudget } from "./acp-coding-harness.js";
import { completeColdStartApprovalDemo, ingestColdStartDrop, probeColdStartReadiness, type ColdStartReadinessReport } from "./cold-start-onboarding.js";
import { GitRefCheckpointManager } from "./git-checkpoint-and-pr-feed.js";
import { AntigravityCodingHarness, CodingHarnessRegistry, RepoBindingRegistry, type RepoBindingRecord, type UpsertRepoBindingInput } from "./repo-binding.js";
import { SafeRelaunchCoordinator, writeBootHealthyStamp, type PostBootNotice } from "./safe-relauncher.js";
import { LazyDesktopPermissionGate } from "./worktree-and-platform-guard.js";
import { SugentSIMStore } from "./self-improvement-memory.js";
import { VibeCodingPipelineOrchestrator, type CommandExecPort, type VibeNotificationEvent, type VibePipelineRecord } from "./vibe-coding-pipeline.js";
import { SugentAvatarStudio } from "./avatar-studio.js";
import { ProviderRegistry } from "./provider-registry.js";
import { SugentModelCatalog, type ModelTier } from "./model-catalog.js";
import { ModelPoolSyncer, type ProviderSyncResult } from "./model-pool-sync.js";
import { RoutingExperienceStore, type RoutingOperatingMode, type RoutingPolicyState, type RoutingStrategyPreset, type TaskArchetype } from "./routing-experience-store.js";
import { AdaptiveModelRouter, type AdaptiveRoutingDashboardSnapshot } from "./adaptive-router.js";
import {
  OpsBridgeClient,
  type OpsInboxItem,
  type OpsProjectPulseInput,
  type OpsRemoteCommand,
  type OpsStewardPendingSnapshot,
} from "./ops-bridge-client.js";
import {
  E2eeOfflineDigestVault,
  PowerSaveBlockerController,
  buildOfflineLedgerDigest,
  type OfflineLedgerDigest,
  type PowerGuardMode,
  type PowerGuardStatus,
  type PowerSaveBlockerDriver,
} from "./offline-digest-and-power-guard.js";
import {
  WeixinAdaptiveQuotaGuard,
  buildThreeSecondForwardedBriefing,
  type ThreeSecondForwardedBriefingResult,
} from "./weixin-quota-and-briefing.js";
import {
  WeaponSoakTelemetryLedger,
  listWeaponPackages,
  runContractQuoteGuardPack,
  runIndustrialFdeDiagnosticPack,
  type CommercialProofSummary,
  type IndustrialExceptionRecord,
  type IndustrialFdeDiagnosticResult,
  type RedlineDiffCard,
  type WeaponPackageManifest,
} from "./weapon-packages.js";
import {
  EdgeTentacleHub,
  type EdgeIngestPulseInput,
  type EdgeNodeStatus,
  type EdgeQueuedCommand,
} from "./edge-tentacle-hub.js";
import {
  ChatTranscriptRecallService,
  type ChatHistoryRecallResult,
  type RecallChatHistoryInput,
} from "./chat-transcript-recall.js";

export interface SugentStewardHostServiceOptions {
  dataDir: string;
  knowledgeGraph: SugentKnowledgeGraph;
  localBudgets: LocalBudgetLedger;
  providerRegistry?: ProviderRegistry;
  modelCatalog?: SugentModelCatalog;
  getGatewayConfig?: () => SugentGatewayConfig;
  conciergeBridge?: ConciergeChannelBridge;
  homeDir?: string;
  nodeId?: string;
  fleetStatePath?: string;
  sidecarsDir?: string;
  agentApiRunner?: AgentApiRunner;
  llmFetch?: typeof fetch;
  recordUsageUsd?: (usd: number) => void;
  nowIso?: () => string;
  vibeNotifyChannel?: (ev: VibeNotificationEvent) => Promise<void> | void;
  requestRelaunchQuit?: () => void;
  hotUpdatePort?: {
    getStatus: () => Record<string, unknown>;
    reloadUi: (file?: string) => Record<string, unknown>;
    reloadCore: (opts?: { reason?: string }) => Promise<{ ok: boolean; error?: string; [k: string]: unknown }>;
    stageBundle: (bundleBase64: string, opts?: { allowUnsigned?: boolean }) => Promise<Record<string, unknown>>;
    rollbackSlot: () => Promise<Record<string, unknown>>;
    factoryReset: () => Promise<Record<string, unknown>>;
  };
  vibeCommandRunner?: CommandExecPort;
  delegateLocalTask?: (input: LocalTaskDelegationInput) => Promise<LocalTaskDelegationResult>;
  opsBridge?: OpsBridgeClient;
  chatRecall?: ChatTranscriptRecallService;
  edgeTokens?: readonly string[];
  manifestPath?: string;
  workspaceRoot?: string;
  powerSaveBlockerDriver?: PowerSaveBlockerDriver;
}

export interface RecentDropRecord {
  inputId: string;
  channel: DropzoneChannel;
  callerDomain: CallerAccessDomain;
  text: string;
  outcome: DropzoneOutcome;
  formattedReply: string;
  atIso: string;
}

export interface ProjectPrivacyView {
  projectKey: string;
  displayName: string;
  aliases: string[];
  workspaceRoot?: string;
  title: string;
  sessionCount: number;
  runningSessionCount: number;
  runningSessions: Array<{ conversationId: string; title: string; stepCount: number; activeSubagentCount: number }>;
  subagentCount: number;
  policy: ProjectPrivacyPolicy;
  preview: SanitizedTierPayloadResult;
}

export interface StewardWorkbenchSnapshot {
  callerDomain: CallerAccessDomain;
  quietHoursActive: boolean;
  activeModel: string;
  llmLive: boolean;
  ledger: LedgerSnapshot;
  budgetStatus?: BotBudgetStatus;
  trustKgStats: { activeTierEdges: number; supersededTierEdges: number };
  cadence: {
    dateKey: string;
    state: CadenceBudgetState;
    lastScan?: {
      atIso: string;
      emitNow: ProactiveCandidate[];
      foldToMorningDigest: ProactiveCandidate[];
      suppressedIds: string[];
    };
    lastMorningDrain?: {
      atIso: string;
      dateKey: string;
      emitNow: ProactiveCandidate[];
      supersededIds: string[];
    };
  };
  antigravity: {
    scannedAtIso: string;
    surfacesScanned: string[];
    totalSessions: number;
    totalSubagentsFolded: number;
    sessions: AntigravitySessionSnapshot[];
    projects: ProjectPrivacyView[];
    fleetEvents: BridgeFleetCadenceEvent[];
  };
  concierge?: ReturnType<ConciergeChannelBridge["getWorkbench"]>;
  recentDrops: RecentDropRecord[];
  vibeCoding: {
    bindings: RepoBindingRecord[];
    pipelines: VibePipelineRecord[];
    lastBootNotice?: PostBootNotice;
  };
  capabilities: CapabilityAwarenessSnapshot;
  skillCandidates?: SkillCandidateSummary[];
  routing?: AdaptiveRoutingDashboardSnapshot;
  hotUpdate?: Record<string, unknown>;
  opsFleet?: OpsStewardPendingSnapshot;
}

function writeJsonAtomic600(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, filePath);
}

function createFileBudgetStorage(filePath: string): CadenceBudgetStoragePort {
  return {
    load(): CadenceBudgetState | undefined {
      try {
        if (!fs.existsSync(filePath)) return undefined;
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as CadenceBudgetState;
        return parsed && typeof parsed.dateKey === "string" ? parsed : undefined;
      } catch {
        return undefined;
      }
    },
    save(state: CadenceBudgetState): void {
      writeJsonAtomic600(filePath, state);
    },
  };
}

function discoverRegisteredProjectKeys(homeDir: string): string[] {
  const dir = path.join(homeDir, ".gemini", "config", "projects");
  const keys: string[] = [];
  try {
    if (!fs.existsSync(dir)) return keys;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as {
          projectResources?: { resources?: Array<{ gitFolder?: { folderUri?: string } }> };
        };
        for (const res of parsed.projectResources?.resources ?? []) {
          const uri = res.gitFolder?.folderUri;
          if (!uri) continue;
          const fsPath = uri.startsWith("file://") ? decodeURIComponent(uri.slice(7)) : uri;
          let remoteUrl: string | undefined;
          try {
            const gitCfg = path.join(fsPath, ".git", "config");
            if (fs.existsSync(gitCfg)) {
              const m = /^\s*url\s*=\s*(.+?)\s*$/m.exec(fs.readFileSync(gitCfg, "utf8"));
              if (m?.[1]) remoteUrl = m[1];
            }
          } catch {
            // ignore git config read error
          }
          keys.push(canonicalizeProjectKey({ folderPath: fsPath, remoteUrl }));
        }
      } catch {
        // ignore single malformed project file
      }
    }
  } catch {
    // ignore missing config directory
  }
  return keys;
}

function discoverConfigProjectRoots(homeDir: string): AuthorizedProjectRoot[] {
  const dir = path.join(homeDir, ".gemini", "config", "projects");
  const out: AuthorizedProjectRoot[] = [];
  try {
    if (!fs.existsSync(dir)) return out;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as {
          projectResources?: { resources?: Array<{ gitFolder?: { folderUri?: string } }> };
        };
        for (const res of parsed.projectResources?.resources ?? []) {
          const uri = res.gitFolder?.folderUri;
          if (!uri) continue;
          const fsPath = uri.startsWith("file://") ? decodeURIComponent(uri.slice(7)) : uri;
          if (!fsPath || !fs.existsSync(fsPath)) continue;
          let remoteUrl: string | undefined;
          try {
            const gitCfg = path.join(fsPath, ".git", "config");
            if (fs.existsSync(gitCfg)) {
              const m = /^\s*url\s*=\s*(.+?)\s*$/m.exec(fs.readFileSync(gitCfg, "utf8"));
              if (m?.[1]) remoteUrl = m[1];
            }
          } catch { /* ignore */ }
          out.push({
            projectKey: canonicalizeProjectKey({ folderPath: fsPath, remoteUrl }),
            displayName: path.basename(fsPath),
            rootPath: path.resolve(fsPath),
            sourceKind: "project_workspace",
          });
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return out;
}

function formatDropzoneReply(outcome: DropzoneOutcome): string {
  switch (outcome.intent) {
    case "capture":
      return `【随手暂存 · ${outcome.selectedModel}】\n${outcome.receiptLine}`;
    case "recall":
      return [
        `【秒翻家底 · ${outcome.selectedModel}】`,
        outcome.answer,
        outcome.matchedRefs.length ? `关联索引：${outcome.matchedRefs.join(" | ")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    case "advise":
      return [
        `【利害参谋 · ${outcome.selectedModel}】`,
        ...outcome.guardrailWarnings,
        outcome.tradeOffBrief,
      ]
        .filter(Boolean)
        .join("\n");
    case "delegate":
      if (outcome.mode === "automated_trigger") {
        return `【交代跑腿 · 自动立项 (${outcome.selectedModel})】\n已生成执行触发器：${outcome.trigger.sourceKind} · ${outcome.trigger.threadKey}`;
      }
      return [
        `【交代跑腿 · 无工具前 80% 准备包 (${outcome.selectedModel})】`,
        `任务：${outcome.bundle.taskTitle}`,
        `人工边界：${outcome.bundle.missingAutomationReason}`,
        "办理清单：",
        ...outcome.bundle.checklist.map((step, i) => `${i + 1}. ${step}`),
        outcome.bundle.localMaterials.length
          ? `已翻齐本地材料：\n${outcome.bundle.localMaterials.map((m) => `- ${m.label} (${m.localPath})`).join("\n")}`
          : "已翻齐本地材料：暂无匹配档案（可在投递口拖入证件/合同补充）",
        outcome.bundle.readyToCopyDrafts[0]
          ? `可直接复制的话术：\n${outcome.bundle.readyToCopyDrafts[0].text}`
          : "",
        `已自动挂账跟进事项：${outcome.followupCommitmentId}`,
      ]
        .filter(Boolean)
        .join("\n");
    case "clarify":
      return [
        `【先查后问 · 单点确认 (${outcome.selectedModel})】`,
        ...outcome.nonBlockingPrepSteps.map((s) => `- [前置已备] ${s}`),
        outcome.question,
        ...outcome.options,
        `默认兜底：${outcome.defaultFallbackAction}`,
      ]
        .filter(Boolean)
        .join("\n");
  }
}

export class SugentStewardHostService {
  readonly ledger: StewardshipLedger;
  readonly privacy: ProjectPrivacyRegistry;
  readonly stateReader: AntigravityStateReader;
  readonly fleetReader: FleetPulseReader;
  readonly causalLedger: CausalLedger;
  readonly simStore: SugentSIMStore;
  readonly suspendedStore: SuspendedRoundStore;
  readonly canonPublisher: LocalDiffCanonPublisher;
  readonly opsSink: PrivacyFilteredOpsProjectionSink;
  readonly artifacts: ArtifactComprehensionPipeline;
  readonly dispatcher: AntigravityDispatcher;
  readonly mcpServer: SugentStewardMcpServer;
  readonly llmAgent: StewardLlmAgent<StewardWorkbenchSnapshot>;
  readonly repoBindings: RepoBindingRegistry;
  readonly fileBridge: HandoffFileBridge;
  readonly relauncher: SafeRelaunchCoordinator;
  readonly codingHarnesses: CodingHarnessRegistry;
  readonly dualTrackCodingBudget: DualTrackCodingBudget;
  readonly gitCheckpoints: GitRefCheckpointManager;
  readonly desktopPermissions: LazyDesktopPermissionGate;
  readonly vibePipeline: VibeCodingPipelineOrchestrator;
  readonly capabilityAwareness: CapabilityAwarenessEngine;
  readonly authorizedFiles: AuthorizedFileReader;
  readonly avatarStudio: SugentAvatarStudio;
  readonly modelCatalog: SugentModelCatalog;
  readonly modelPoolSync: ModelPoolSyncer;
  readonly routingExperience: RoutingExperienceStore;
  readonly adaptiveRouter: AdaptiveModelRouter;
  readonly powerGuard: PowerSaveBlockerController;
  readonly offlineVault: E2eeOfflineDigestVault;
  readonly weixinQuotaGuard: WeixinAdaptiveQuotaGuard;
  readonly weaponSoakLedger: WeaponSoakTelemetryLedger;
  readonly edgeHub: EdgeTentacleHub;
  readonly chatRecall: ChatTranscriptRecallService;
  private readonly homeDir: string;
  private lastBootNotice?: PostBootNotice;
  private lastRouteTurn?: {
    text: string;
    history?: Array<{ role: "user" | "assistant"; content: string }>;
    channel?: DropzoneChannel;
    decisionId: string;
    targetId: string;
    archetype: TaskArchetype;
    tier: ModelTier;
    atMs: number;
  };
  private readonly budgetGate: ReturnType<typeof createAttentionBudgetGate>;
  private readonly nowIsoFn: () => string;
  private readonly viewedPath: string;
  private readonly prefsPath: string;
  private readonly pulseStatePath: string;
  private readonly viewedWatermarks: Record<string, number> = {};
  private readonly recentDrops: RecentDropRecord[] = [];
  private readonly conversationEngine: StewardConversationEngine<StewardWorkbenchSnapshot>;
  private quietHoursActive = false;
  private lastScanResult?: AntigravityScanResult;
  private lastCadenceScan?: StewardWorkbenchSnapshot["cadence"]["lastScan"];
  private lastMorningDrain?: StewardWorkbenchSnapshot["cadence"]["lastMorningDrain"];
  private remoteOpsSnapshot?: OpsStewardPendingSnapshot;
  private readonly stagedOpsInbox = new Map<string, OpsInboxItem>();

  constructor(private readonly opts: SugentStewardHostServiceOptions) {
    this.nowIsoFn = opts.nowIso ?? (() => new Date().toISOString());
    const homeDir = opts.homeDir ?? os.homedir();
    this.homeDir = homeDir;
    const nodeId = opts.nodeId ?? "local-mac";
    const nowMs = Date.parse(this.nowIsoFn()) || Date.now();
    const stewardDir = resolveUnifiedCausalLedgerDir(opts.dataDir);

    this.ledger = new StewardshipLedger({
      dataDir: opts.dataDir,
      knowledgeGraph: opts.knowledgeGraph,
      budgetLedger: opts.localBudgets,
    });
    this.privacy = new ProjectPrivacyRegistry({
      dataDir: opts.dataDir,
      registeredProjectKeys: discoverRegisteredProjectKeys(homeDir),
      nowIso: this.nowIsoFn,
    });
    this.causalLedger = new CausalLedger(stewardDir);
    this.simStore = new SugentSIMStore(opts.dataDir);
    this.suspendedStore = new SuspendedRoundStore(stewardDir);
    this.canonPublisher = new LocalDiffCanonPublisher();
    this.opsSink = new PrivacyFilteredOpsProjectionSink(this.privacy);
    this.artifacts = new ArtifactComprehensionPipeline({
      homeDir,
      sealWorkspaceDir: path.join(stewardDir, "seal-workspace"),
      privacyRegistry: this.privacy,
      ledger: this.ledger,
      getGatewayConfig: opts.getGatewayConfig,
      suspendedStore: this.suspendedStore,
    });
    this.dispatcher = new AntigravityDispatcher({
      runner: opts.agentApiRunner,
      causalLedger: this.causalLedger,
      sidecarsDir: opts.sidecarsDir ?? path.join(homeDir, ".gemini", "config", "sidecars"),
      nowIso: this.nowIsoFn,
    });
    this.mcpServer = new SugentStewardMcpServer({
      ledger: this.ledger,
      privacyRegistry: this.privacy,
      suspendedStore: this.suspendedStore,
      canonPublisher: this.canonPublisher,
      opsSink: this.opsSink,
      nowIso: this.nowIsoFn,
    });
    this.stateReader = new AntigravityStateReader({
      homeDir,
      nodeId,
      bootstrappedAtMs: nowMs - 48 * 3_600_000,
      cutoverHours: 48,
    });
    this.fleetReader = new FleetPulseReader({
      stateFilePath: opts.fleetStatePath ?? path.join(stewardDir, ".ops_fleet_state.json"),
      fallbackNodeId: nodeId,
      nowIso: this.nowIsoFn,
    });
    this.budgetGate = createAttentionBudgetGate(createFileBudgetStorage(path.join(stewardDir, "cadence-budget.json")), 0);
    this.viewedPath = path.join(stewardDir, "viewed-sessions.json");
    this.prefsPath = path.join(stewardDir, "steward-prefs.json");
    this.pulseStatePath = path.join(stewardDir, "pulse-state.json");
    this.loadViewedWatermarks();
    this.loadPrefs();
    this.repoBindings = new RepoBindingRegistry({ dataDir: opts.dataDir, nowIso: this.nowIsoFn });
    this.fileBridge = new HandoffFileBridge({ dataDir: opts.dataDir, ledger: this.ledger });
    this.relauncher = new SafeRelaunchCoordinator({ dataDir: opts.dataDir, requestGracefulQuit: opts.requestRelaunchQuit });
    this.dualTrackCodingBudget = new DualTrackCodingBudget();
    this.gitCheckpoints = new GitRefCheckpointManager();
    this.desktopPermissions = new LazyDesktopPermissionGate();
    this.desktopPermissions.onAppBoot();
    this.powerGuard = new PowerSaveBlockerController({
      ...(opts.powerSaveBlockerDriver ? { driver: opts.powerSaveBlockerDriver } : {}),
    });
    this.offlineVault = new E2eeOfflineDigestVault({ dataDir: opts.dataDir });
    this.weixinQuotaGuard = new WeixinAdaptiveQuotaGuard();
    this.weaponSoakLedger = new WeaponSoakTelemetryLedger(opts.dataDir);
    this.edgeHub = new EdgeTentacleHub({
      dataDir: opts.dataDir,
      edgeTokens: opts.edgeTokens,
      now: () => Date.parse(this.nowIsoFn()) || Date.now(),
    });
    this.chatRecall = opts.chatRecall ?? new ChatTranscriptRecallService({
      dataDir: opts.dataDir,
      nowMs: () => Date.parse(this.nowIsoFn()) || Date.now(),
    });
    this.codingHarnesses = new CodingHarnessRegistry([
      new AntigravityCodingHarness(this.dispatcher),
      new AcpCodingHarness({ backend: "claude_code" }),
      new AcpCodingHarness({ backend: "codex" }),
      new AcpCodingHarness({ backend: "opencode" }),
      new AcpCodingHarness({ backend: "pi" }),
    ]);
    this.vibePipeline = new VibeCodingPipelineOrchestrator({
      dataDir: opts.dataDir,
      bindings: this.repoBindings,
      fileBridge: this.fileBridge,
      harnesses: this.codingHarnesses,
      ledger: this.ledger,
      suspendedStore: this.suspendedStore,
      causalLedger: this.causalLedger,
      relauncher: this.relauncher,
      commandRunner: opts.vibeCommandRunner,
      notifyChannel: opts.vibeNotifyChannel,
      ...(opts.hotUpdatePort ? { requestCoreHotReload: (o) => opts.hotUpdatePort!.reloadCore(o) } : {}),
      nowIso: this.nowIsoFn,
    });
    this.capabilityAwareness = new CapabilityAwarenessEngine({
      dataDir: opts.dataDir,
      manifestPath: opts.manifestPath,
      workspaceRoot: opts.workspaceRoot,
      knowledgeGraph: opts.knowledgeGraph,
      tools: STEWARD_CAPABILITY_DESCRIPTORS,
      nowIso: this.nowIsoFn,
    });
    this.authorizedFiles = new AuthorizedFileReader({
      homeDir,
      getProjectRoots: () => this.getAuthorizedProjectRoots(),
      privacyRegistry: this.privacy,
      ledger: this.ledger,
    });
    this.avatarStudio = new SugentAvatarStudio(opts.dataDir, {
      providerRegistry: opts.providerRegistry,
      fetchImpl: opts.llmFetch,
    });
    this.conversationEngine = new StewardConversationEngine({
      getWorkbench: (d) => this.getWorkbench(d),
      submitDropzone: (i) => this.submitDropzone(i),
      mutateTrust: (i) => this.mutateTrust(i),
      mutateGoal: (i) => this.mutateGoal(i),
      mutateCommitment: (i) => this.mutateCommitment(i),
      scanCadence: (i) => this.scanCadence(i),
      setQuietHours: (active, d) => this.setQuietHours(active, d),
      setProjectTier: (i) => this.setProjectTier(i),
      markSessionViewed: (i) => this.markSessionViewed(i),
      bindSelfRepo: (o) => this.bindSelfRepo(o),
      upsertRepoBinding: (i) => this.upsertRepoBinding(i),
      startVibeTask: (i) => this.startVibeTask(i),
      decideVibeTask: (i) => this.decideVibeTask(i),
      searchAuthorizedFiles: (i) => this.searchAuthorizedFiles(i),
      readAuthorizedFile: (i) => this.readAuthorizedFile(i),
      ...(opts.conciergeBridge
        ? {
            executeConciergeCommand: (cmd, ch) => opts.conciergeBridge!.executeOwnerCommand(cmd, ch),
          }
        : {}),
    });
    this.modelCatalog = opts.modelCatalog ?? new SugentModelCatalog(opts.dataDir);
    const registryForPool = opts.providerRegistry ?? new ProviderRegistry(opts.dataDir);
    this.modelPoolSync = new ModelPoolSyncer({
      dataDir: opts.dataDir,
      providers: registryForPool,
      catalog: this.modelCatalog,
      fetchImpl: opts.llmFetch,
    });
    this.routingExperience = new RoutingExperienceStore({ dataDir: opts.dataDir });
    this.adaptiveRouter = new AdaptiveModelRouter({
      pool: this.modelPoolSync,
      experience: this.routingExperience,
      providers: registryForPool,
      catalog: this.modelCatalog,
      localBudgets: opts.localBudgets,
      causalLedger: this.causalLedger,
      getFallbackEndpoint: () => this.resolveLiveLlmEndpoint(),
    });
    this.llmAgent = new StewardLlmAgent({
      getEndpoint: () => this.resolveLiveLlmEndpoint(),
      fetchImpl: opts.llmFetch,
      recordUsageUsd: opts.recordUsageUsd,
      resolveRoutePlan: (ctx) => this.adaptiveRouter.planRoute(ctx),
      estimateCostUsd: (model, usage) => this.modelCatalog.estimateCostUsd(model, usage),
      onRouteAttemptOutcome: (ev) => this.adaptiveRouter.recordAttemptOutcome(ev),
      toolsPort: {
        getWorkbench: (d) => this.getWorkbench(d),
        queryLedger: (q, d) => this.ledger.queryContext(q, d),
        findArchiveResources: (q, d) => this.ledger.findArchiveResources(q, d),
        recallKnowledgeSubgraph: (q) => this.opts.knowledgeGraph.recallSubgraph(q, 2).matchedNodes,
        upsertArchiveResource: (i) => {
          if (i.filePaths?.length) {
            return i.filePaths.map((fp) =>
              this.ledger.upsertResource({ partition: i.partition, kind: "personal_archive", title: i.title, localUriOrPath: fp, ...(i.dueAt ? { expiresAt: i.dueAt } : {}), metadata: { source: "llm_agent" } }, this.nowIsoFn()),
            );
          }
          return [this.ledger.upsertResource({ partition: i.partition, kind: "personal_archive", title: i.title, ...(i.dueAt ? { expiresAt: i.dueAt } : {}), metadata: { source: "llm_agent" } }, this.nowIsoFn())];
        },
        mutateCommitment: (i) => this.mutateCommitment(i),
        mutateGoal: (i) => this.mutateGoal(i),
        mutateTrust: (i) => this.mutateTrust(i),
        submitDropzone: (i) => this.submitDropzone(i),
        scanCadence: (i) => this.scanCadence(i),
        setQuietHours: (a, d) => this.setQuietHours(a, d),
        setProjectTier: (i) => this.setProjectTier(i),
        markSessionViewed: (i) => this.markSessionViewed(i),
        comprehendSession: (i) => this.comprehendSession(i),
        dispatchAntigravity: (i) => this.dispatchAntigravity(i),
        bindSelfRepo: (o) => this.bindSelfRepo(o),
        upsertRepoBinding: (i) => this.upsertRepoBinding(i),
        startVibeTask: (i) => this.startVibeTask(i),
        decideVibeTask: (i) => this.decideVibeTask(i),
        searchAuthorizedFiles: (i) => this.searchAuthorizedFiles(i),
        readAuthorizedFile: (i) => this.readAuthorizedFile(i),
        getRoutingDashboard: () => this.getRoutingDashboard(),
        syncModelPool: (o) => this.syncModelPool(o),
        updateRoutingPolicy: (patch) => this.updateRoutingPolicy(patch),
        manageHotUpdate: (input) => this.executeHotUpdateAction(input),
        refreshOpsFleet: () => this.refreshRemoteOpsSnapshot(),
        proposeOpsInbox: (input) => this.proposeOpsInbox(input),
        recallChatHistory: (input) => this.recallChatHistory(input),
        dispatchEdgeAntigravity: (input) => this.dispatchEdgeAntigravity(input),
        ...(opts.delegateLocalTask ? { delegateLocalTask: opts.delegateLocalTask } : {}),
        ...(opts.conciergeBridge ? { executeConciergeCommand: (cmd, ch) => opts.conciergeBridge!.executeOwnerCommand(cmd, ch) } : {}),
      },
    });
  }

  hasLiveLlmEndpoint(): boolean {
    return Boolean(this.resolveLiveLlmEndpoint());
  }

  private resolveLiveLlmEndpoint(): StewardLlmEndpoint | undefined {
    const gw = this.opts.getGatewayConfig?.() ?? resolveSugentGatewayConfig(undefined, {});
    if (gw.baseUrl && gw.apiKey) return { baseUrl: gw.baseUrl, apiKey: gw.apiKey, model: selectModelForRole(gw, "steward") };
    const def = this.opts.providerRegistry?.getDefaultProvider();
    if (def?.enabled && def.baseUrl) {
      return { baseUrl: def.baseUrl, apiKey: def.apiKey, model: def.defaultModel || def.models?.[0] || selectModelForRole(gw, "steward") };
    }
    return undefined;
  }

  async comprehendSession(input: ArtifactComprehensionInput): Promise<ArtifactComprehensionResult> {
    const { scan } = this.scanAntigravity();
    const sess = scan.sessions.find((s) => s.conversationId === input.conversationId) ??
      scan.sessions.find((s) => s.projectKey === input.projectKey);
    return this.artifacts.comprehendSession({
      ...input,
      projectDisplayName: input.projectDisplayName ?? sess?.projectDisplayName,
      workspaceRoot: input.workspaceRoot ?? sess?.workspaceRoot,
      surface: input.surface ?? sess?.surface,
      title: input.title ?? sess?.title,
      isRunning: input.isRunning ?? sess?.isRunning,
      notFullyIdle: input.notFullyIdle ?? sess?.notFullyIdle,
      stepCount: input.stepCount ?? sess?.stepCount,
      lastUserInputStepIndex: input.lastUserInputStepIndex ?? sess?.lastUserInputStepIndex,
      activeSubagentCount: input.activeSubagentCount ?? sess?.activeSubagentCount,
      activeChildConversationIds: input.activeChildConversationIds ?? sess?.activeChildConversationIds,
      nowIso: input.nowIso ?? this.nowIsoFn(),
    });
  }

  async dispatchAntigravity(input: {
    mode: "resume" | "new";
    conversationId?: string;
    prompt: string;
    title?: string;
    workspacePath?: string;
    hopCount?: number;
  }): Promise<DispatchOutcome> {
    if (input.mode === "resume" && input.conversationId) {
      return this.dispatcher.resumeSession({ conversationId: input.conversationId, content: input.prompt, title: input.title, hopCount: input.hopCount });
    }
    return this.dispatcher.startNewSession({ prompt: input.prompt, title: input.title, workspacePath: input.workspacePath, hopCount: input.hopCount });
  }

  private loadPrefs(): void {
    try {
      if (!fs.existsSync(this.prefsPath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.prefsPath, "utf8")) as { quietHoursActive?: unknown };
      if (typeof parsed?.quietHoursActive === "boolean") this.quietHoursActive = parsed.quietHoursActive;
    } catch {
      // ignore corrupted prefs cache
    }
  }

  setQuietHours(
    active: boolean,
    callerDomain: CallerAccessDomain = "owner_private",
  ): { quietHoursActive: boolean; workbench: StewardWorkbenchSnapshot } {
    this.quietHoursActive = Boolean(active);
    writeJsonAtomic600(this.prefsPath, { quietHoursActive: this.quietHoursActive });
    return { quietHoursActive: this.quietHoursActive, workbench: this.getWorkbench(callerDomain) };
  }

  async syncModelPool(opts?: { providerId?: string; force?: boolean }): Promise<ProviderSyncResult[]> {
    if (opts?.providerId) return [await this.modelPoolSync.syncProvider(opts.providerId, { force: opts.force })];
    return (await this.modelPoolSync.syncAllEnabled({ force: opts?.force })).results;
  }

  getRoutingDashboard(): AdaptiveRoutingDashboardSnapshot {
    return this.adaptiveRouter.getDashboardSnapshot();
  }

  updateRoutingPolicy(patch: {
    strategy?: RoutingStrategyPreset;
    mode?: RoutingOperatingMode;
    pinnedModel?: string | null;
    blockedModels?: string[];
    unblockModel?: string;
    resetBoosts?: boolean;
    directive?: string;
  }) {
    const hasDirectPatch =
      patch.strategy !== undefined ||
      patch.mode !== undefined ||
      patch.pinnedModel !== undefined ||
      patch.blockedModels !== undefined ||
      patch.unblockModel !== undefined ||
      patch.resetBoosts !== undefined;
    if (hasDirectPatch) this.routingExperience.updatePolicy(patch);
    if (patch.directive) {
      const known = this.modelPoolSync.listChatCandidates().map((e) => e.targetId);
      const res = this.routingExperience.applyNaturalLanguageDirective(patch.directive, known);
      return { ...res, dashboard: this.getRoutingDashboard() };
    }
    return { matched: true, policy: this.routingExperience.getPolicy(), dashboard: this.getRoutingDashboard() };
  }

  async retryLastTurnStronger(callerDomain: CallerAccessDomain = "owner_private") {
    const prev = this.lastRouteTurn;
    if (!prev) return { ok: false as const, errorCode: "NO_PREVIOUS_TURN", workbench: this.getWorkbench(callerDomain) };
    this.adaptiveRouter.recordAttemptOutcome({ decisionId: prev.decisionId, targetId: prev.targetId, archetype: prev.archetype, ok: false, signalSource: "explicit_retry_stronger" });
    const tierUp: ModelTier = prev.tier === "fast" ? "balanced" : prev.tier === "balanced" ? "frontier" : "reasoning";
    const out = await this.llmAgent.runTurn({ text: prev.text, history: prev.history, callerDomain, channel: prev.channel, excludeTargetIds: [prev.targetId], forceMinTier: tierUp });
    if (!out.ok) return { ok: false as const, errorCode: out.fallbackReason, workbench: this.getWorkbench(callerDomain) };
    const entry = out.routeMeta ? this.modelPoolSync.getEntry(out.routeMeta.targetId) : undefined;
    this.lastRouteTurn = { ...prev, decisionId: out.routeMeta?.decisionId ?? prev.decisionId, targetId: out.routeMeta?.targetId ?? prev.targetId, tier: entry?.profile.tier ?? tierUp, atMs: Date.now() };
    return { ok: true as const, intent: "llm_agent" as const, reply: out.reply, modelUsed: out.modelUsed, routeMeta: out.routeMeta, workbench: out.workbench };
  }

  async converse(
    input: StewardConversationTurnInput & { history?: Array<{ role: "user" | "assistant"; content: string }> },
  ): Promise<StewardConversationResult<StewardWorkbenchSnapshot> & { modelUsed?: string; toolCallsExecuted?: string[]; routeMeta?: StewardRouteMeta }> {
    if (this.lastRouteTurn && this.routingExperience.detectImplicitUserCorrection({ userText: this.lastRouteTurn.text, atMs: this.lastRouteTurn.atMs }, input.text)) {
      this.adaptiveRouter.recordAttemptOutcome({ decisionId: this.lastRouteTurn.decisionId, targetId: this.lastRouteTurn.targetId, archetype: this.lastRouteTurn.archetype, ok: false, signalSource: "user_correction" });
    }
    const llmOut = await this.llmAgent.runTurn({
      text: input.text,
      history: input.history,
      callerDomain: input.callerDomain,
      channel: input.channel,
    });
    if (llmOut.ok) {
      if (llmOut.routeMeta) {
        const entry = this.modelPoolSync.getEntry(llmOut.routeMeta.targetId);
        this.lastRouteTurn = { text: input.text, history: input.history, channel: input.channel, decisionId: llmOut.routeMeta.decisionId, targetId: llmOut.routeMeta.targetId, archetype: llmOut.routeMeta.archetype, tier: entry?.profile.tier ?? "balanced", atMs: Date.now() };
      }
      return {
        ok: true,
        intent: "llm_agent",
        reply: llmOut.reply,
        workbench: llmOut.workbench,
        modelUsed: llmOut.modelUsed,
        toolCallsExecuted: llmOut.toolCallsExecuted,
        ...(llmOut.routeMeta ? { routeMeta: llmOut.routeMeta } : {}),
      };
    }
    return this.conversationEngine.converse(input);
  }

  private loadViewedWatermarks(): void {
    try {
      if (!fs.existsSync(this.viewedPath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.viewedPath, "utf8")) as Record<string, number>;
      for (const [k, v] of Object.entries(parsed ?? {})) {
        if (typeof v === "number" && Number.isFinite(v)) this.viewedWatermarks[k] = v;
      }
    } catch {
      // ignore corrupted watermark cache
    }
  }

  private makeDropzone(): UniversalDropzone {
    const live = this.resolveLiveLlmEndpoint();
    return new UniversalDropzone({
      ledger: this.ledger,
      knowledgeGraph: this.opts.knowledgeGraph,
      gatewayConfig: this.opts.getGatewayConfig?.() ?? resolveSugentGatewayConfig(undefined, {}),
      ...(live
        ? {
            adviseGenerator: async ({ input, contextSummary, model }) => {
              const f = this.opts.llmFetch ?? fetch;
              try {
                const res = await f(`${live.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", Authorization: `Bearer ${live.apiKey}`, "User-Agent": "Sugent/0.1" },
                  body: JSON.stringify({
                    model: model || live.model,
                    messages: [
                      { role: "system", content: "你是主人的贴身参谋，请结合下方目标、忌讳与红线上下文，直接用自然精炼的中文给出利弊判断与可落地的建议。" },
                      { role: "user", content: `问题：${input.text}\n\n账本参考：\n${contextSummary}` },
                    ],
                  }),
                  signal: AbortSignal.timeout(45_000),
                });
                if (!res.ok) return "";
                const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
                return String(json.choices?.[0]?.message?.content ?? "").trim();
              } catch {
                return "";
              }
            },
          }
        : {}),
    });
  }

  private currentDateKey(iso = this.nowIsoFn()): string {
    return iso.slice(0, 10);
  }

  private scanAntigravity(): { scan: AntigravityScanResult; fleetEvents: BridgeFleetCadenceEvent[] } {
    const nowMs = Date.parse(this.nowIsoFn()) || Date.now();
    const scan = this.stateReader.scan({
      nowMs,
      bootstrappedAtMs: nowMs - 48 * 3_600_000,
      externalReadWatermarkMs: this.viewedWatermarks,
    });
    this.lastScanResult = scan;
    return { scan, fleetEvents: this.fleetReader.read() };
  }

  private buildProjectViews(sessions: readonly AntigravitySessionSnapshot[]): ProjectPrivacyView[] {
    const grouped = new Map<string, {
      workspaceRoot?: string;
      displayName: string;
      aliases: Set<string>;
      title: string;
      latestMs: number;
      sessionCount: number;
      runningSessions: Array<{ conversationId: string; title: string; stepCount: number; activeSubagentCount: number }>;
      subagentCount: number;
      volumeOffline: boolean;
    }>();
    for (const s of sessions) {
      const prev = grouped.get(s.projectKey);
      const ms = s.effectiveLastModifiedMs ?? s.lastModifiedMs ?? 0;
      const slug = s.projectKey.replace(/^repo:[^/]+\//, "").replace(/^local:[^:]+:/, "");
      const folderBase = s.workspaceRoot ? path.basename(s.workspaceRoot) : "";
      const runningEntry = s.isRunning
        ? { conversationId: s.conversationId, title: s.title || s.conversationId.slice(0, 8), stepCount: s.stepCount, activeSubagentCount: s.activeSubagentCount }
        : null;
      if (!prev) {
        const aliases = new Set([s.projectDisplayName, slug, folderBase, s.projectKey].filter(Boolean));
        grouped.set(s.projectKey, {
          ...(s.workspaceRoot ? { workspaceRoot: s.workspaceRoot } : {}),
          displayName: s.projectDisplayName || slug,
          aliases,
          title: s.title || s.projectDisplayName || slug,
          latestMs: ms,
          sessionCount: 1,
          runningSessions: runningEntry ? [runningEntry] : [],
          subagentCount: s.subagentCount,
          volumeOffline: s.volumeOffline,
        });
      } else {
        prev.sessionCount += 1;
        prev.subagentCount += s.subagentCount;
        if (s.projectDisplayName) prev.aliases.add(s.projectDisplayName);
        if (slug) prev.aliases.add(slug);
        if (folderBase) prev.aliases.add(folderBase);
        if (runningEntry) prev.runningSessions.push(runningEntry);
        if (ms > prev.latestMs) {
          prev.latestMs = ms;
          if (s.title) prev.title = s.title;
          if (s.projectDisplayName && s.sessionRole === "interactive") prev.displayName = s.projectDisplayName;
        }
      }
    }
    const entries = Array.from(grouped.entries())
      .sort((a, b) => ((b[1].runningSessions.length > 0 ? 1 : 0) - (a[1].runningSessions.length > 0 ? 1 : 0)) || (b[1].latestMs - a[1].latestMs))
      .slice(0, 24);
    return entries.map(([projectKey, meta]) => {
      const policy = this.privacy.resolveProjectPolicy({
        projectKey,
        ...(meta.workspaceRoot ? { workspaceRoot: meta.workspaceRoot } : {}),
        title: meta.title,
        isExternalVolume: meta.volumeOffline,
      });
      const preview = this.privacy.sanitizeForProjectTier(
        {
          projectKey,
          title: meta.title,
          summary: `最近根会话：${meta.title}（含 ${meta.subagentCount} 个子代理）`,
          markdown: `## 治理摘要\n- 项目：${meta.displayName}\n- 根会话数：${meta.sessionCount}`,
          workspaceRoot: meta.workspaceRoot ?? "",
        },
        projectKey,
        policy.tierEpoch,
      );
      return {
        projectKey,
        displayName: meta.displayName,
        aliases: Array.from(meta.aliases),
        ...(meta.workspaceRoot ? { workspaceRoot: meta.workspaceRoot } : {}),
        title: meta.title,
        sessionCount: meta.sessionCount,
        runningSessionCount: meta.runningSessions.length,
        runningSessions: meta.runningSessions.slice(0, 3),
        subagentCount: meta.subagentCount,
        policy,
        preview,
      };
    });
  }

  getWorkbench(callerDomain: CallerAccessDomain = "owner_private"): StewardWorkbenchSnapshot {
    const nowIso = this.nowIsoFn();
    const dateKey = this.currentDateKey(nowIso);
    const ledger = this.ledger.snapshotForCaller(callerDomain);
    const budgetStatus = this.ledger.queryContext("", callerDomain, Date.parse(nowIso) || Date.now()).budgetStatus;
    const { scan, fleetEvents } = this.scanAntigravity();
    const sortedSessions = [...scan.sessions].sort(
      (a, b) => ((b.isRunning ? 1 : 0) - (a.isRunning ? 1 : 0)) || ((b.effectiveLastModifiedMs ?? b.lastModifiedMs ?? 0) - (a.effectiveLastModifiedMs ?? a.lastModifiedMs ?? 0)),
    );
    const totalSubagentsFolded = scan.sessions.reduce((acc, s) => acc + s.subagentCount, 0);
    const allTierEdges = this.opts.knowledgeGraph.allEdges().filter((e) => e.relation === "has_trust_tier");
    const activeTierEdges = allTierEdges.filter((e) => !e.supersededAt).length;
    const supersededTierEdges = allTierEdges.filter((e) => Boolean(e.supersededAt)).length;
    const live = this.resolveLiveLlmEndpoint();
    const gw = this.opts.getGatewayConfig?.() ?? resolveSugentGatewayConfig(undefined, {});
    const routing = this.getRoutingDashboard();
    const latestDecision = routing.recentDecisions[0];
    return {
      callerDomain,
      quietHoursActive: this.quietHoursActive,
      activeModel: latestDecision?.rawModelId ?? live?.model ?? selectModelForRole(gw, "steward"),
      llmLive: Boolean(live) || routing.pool.healthyChatModels > 0,
      ledger,
      ...(budgetStatus ? { budgetStatus } : {}),
      trustKgStats: { activeTierEdges, supersededTierEdges },
      cadence: {
        dateKey,
        state: this.budgetGate.getState(dateKey),
        ...(this.lastCadenceScan ? { lastScan: this.lastCadenceScan } : {}),
        ...(this.lastMorningDrain ? { lastMorningDrain: this.lastMorningDrain } : {}),
      },
      antigravity: {
        scannedAtIso: scan.scannedAtIso,
        surfacesScanned: scan.surfacesScanned,
        totalSessions: scan.sessions.length,
        totalSubagentsFolded,
        sessions: sortedSessions.slice(0, 30),
        projects: this.buildProjectViews(sortedSessions),
        fleetEvents,
      },
      ...(this.opts.conciergeBridge ? { concierge: this.opts.conciergeBridge.getWorkbench(Date.now()) } : {}),
      recentDrops: this.recentDrops.slice(0, 12),
      vibeCoding: {
        bindings: this.repoBindings.listBindings(),
        pipelines: this.vibePipeline.listPipelines().slice(0, 12),
        ...(this.lastBootNotice ? { lastBootNotice: this.lastBootNotice } : {}),
      },
      capabilities: this.capabilityAwareness.snapshot(this.getAuthorizedProjectRoots(scan).length),
      ...(callerDomain === "owner_private"
        ? { skillCandidates: this.opts.knowledgeGraph.listSkillCandidates({ threshold: 3 }) }
        : {}),
      ...(callerDomain === "owner_private"
        ? (() => {
            const mergedFleet = this.getMergedOpsFleetSnapshot();
            return mergedFleet ? { opsFleet: mergedFleet } : {};
          })()
        : {}),
      routing,
      ...(this.opts.hotUpdatePort ? { hotUpdate: this.getHotUpdateStatus() } : {}),
    };
  }

  async submitDropzone(input: {
    text: string;
    channel?: DropzoneChannel;
    partition?: ContextPartition;
    callerDomain?: CallerAccessDomain;
    filePaths?: string[];
  }): Promise<{
    ok: true;
    outcome: DropzoneOutcome;
    formattedReply: string;
    workbench: StewardWorkbenchSnapshot;
  }> {
    const callerDomain: CallerAccessDomain = input.callerDomain ?? "owner_private";
    const defaultPartition: ContextPartition =
      input.partition ?? (callerDomain === "owner_private" ? "personal_life" : callerDomain);
    const nowIso = this.nowIsoFn();
    const inputId = `drop-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    const outcome = await this.makeDropzone().handle({
      inputId,
      channel: input.channel ?? "web_ui",
      partition: defaultPartition,
      callerDomain,
      text: String(input.text ?? ""),
      ...(input.filePaths?.length ? { filePaths: input.filePaths } : {}),
      receivedAtIso: nowIso,
    });
    const formattedReply = formatDropzoneReply(outcome);
    this.recentDrops.unshift({
      inputId,
      channel: input.channel ?? "web_ui",
      callerDomain,
      text: String(input.text ?? ""),
      outcome,
      formattedReply,
      atIso: nowIso,
    });
    if (this.recentDrops.length > 24) this.recentDrops.length = 24;
    return { ok: true, outcome, formattedReply, workbench: this.getWorkbench(callerDomain) };
  }

  mutateTrust(input: {
    id: string;
    action: "observe" | "promote_l3" | "downgrade";
    ownerConfirmed?: boolean;
    targetTier?: TrustTier;
    directiveText?: string;
    callerDomain?: CallerAccessDomain;
  }): {
    ok: boolean;
    errorCode?: string;
    message?: string;
    profile?: RelationshipProfile;
    canSuggestPromotion?: boolean;
    workbench: StewardWorkbenchSnapshot;
  } {
    const nowIso = this.nowIsoFn();
    try {
      if (input.action === "observe") {
        const res = this.ledger.recordVerifiedObservation(input.id, nowIso);
        return {
          ok: true,
          profile: res.profile,
          canSuggestPromotion: res.canSuggestPromotion,
          workbench: this.getWorkbench(input.callerDomain ?? "owner_private"),
        };
      }
      if (input.action === "promote_l3") {
        const profile = this.ledger.promoteTrustTier(input.id, "L3_shadow_autonomous", {
          ownerConfirmed: Boolean(input.ownerConfirmed),
          nowIso,
        });
        return { ok: true, profile, workbench: this.getWorkbench(input.callerDomain ?? "owner_private") };
      }
      const profile = input.directiveText?.trim()
        ? this.ledger.applyOwnerTrustDirective(input.id, input.directiveText, nowIso)
        : this.ledger.downgradeTrustTier(input.id, input.targetTier ?? "L1_whisper_prompt", "manual_ui_downgrade", nowIso);
      return { ok: true, profile, workbench: this.getWorkbench(input.callerDomain ?? "owner_private") };
    } catch (err) {
      const code = err instanceof StewardshipLedgerError ? err.code : "TRUST_ERROR";
      return {
        ok: false,
        errorCode: code,
        message: err instanceof Error ? err.message : String(err),
        workbench: this.getWorkbench(input.callerDomain ?? "owner_private"),
      };
    }
  }

  mutateGoal(input: {
    action: "upsert" | "status";
    id?: string;
    partition?: ContextPartition;
    title?: string;
    northStarCriterion?: string;
    status?: GoalNorthStar["status"];
    supersedeGoalId?: string;
    callerDomain?: CallerAccessDomain;
  }): {
    ok: boolean;
    errorCode?: string;
    message?: string;
    goal?: GoalNorthStar;
    activeGoals?: GoalNorthStar[];
    workbench: StewardWorkbenchSnapshot;
  } {
    const callerDomain = input.callerDomain ?? "owner_private";
    const nowIso = this.nowIsoFn();
    try {
      const goal =
        input.action === "status" && input.id && input.status
          ? this.ledger.updateGoalStatus(input.id, input.status, nowIso)
          : this.ledger.upsertGoal(
              {
                ...(input.id ? { id: input.id } : {}),
                partition: input.partition ?? "work_project",
                title: input.title ?? "未命名主目标",
                northStarCriterion: input.northStarCriterion ?? "按时验收通过",
                ...(input.status ? { status: input.status } : {}),
              },
              {
                ...(input.supersedeGoalId ? { supersedeGoalId: input.supersedeGoalId } : {}),
                nowIso,
              },
            );
      return { ok: true, goal, workbench: this.getWorkbench(callerDomain) };
    } catch (err) {
      const code = err instanceof StewardshipLedgerError ? err.code : "GOAL_ERROR";
      const activeGoals = this.ledger.snapshotForCaller("owner_private").goals.filter((g) => g.status === "active");
      return {
        ok: false,
        errorCode: code,
        message: err instanceof Error ? err.message : String(err),
        activeGoals,
        workbench: this.getWorkbench(callerDomain),
      };
    }
  }

  mutateCommitment(input: {
    action: "upsert" | "status";
    id?: string;
    partition?: ContextPartition;
    direction?: CommitmentItem["direction"];
    summary?: string;
    counterpartyOrRef?: string;
    dueAt?: string;
    status?: CommitmentItem["status"];
    callerDomain?: CallerAccessDomain;
  }): { ok: true; commitment: CommitmentItem; workbench: StewardWorkbenchSnapshot } {
    const callerDomain = input.callerDomain ?? "owner_private";
    const nowIso = this.nowIsoFn();
    const commitment =
      input.action === "status" && input.id && input.status
        ? this.ledger.updateCommitmentStatus(input.id, input.status, nowIso)
        : this.ledger.upsertCommitment(
            {
              ...(input.id ? { id: input.id } : {}),
              partition: input.partition ?? "personal_life",
              direction: input.direction ?? "i_owe",
              summary: input.summary ?? "跟进待办事项",
              counterpartyOrRef: input.counterpartyOrRef ?? "待办",
              ...(input.dueAt ? { dueAt: input.dueAt } : {}),
              ...(input.status ? { status: input.status } : {}),
            },
            nowIso,
          );
    if (input.action === "status" && input.status === "closed") {
      const ownerRel = this.ledger.snapshotForCaller("owner_private").relationships.find((r) => r.subjectType === "owner_trust");
      if (ownerRel) this.ledger.recordVerifiedObservation(ownerRel.id, nowIso);
    }
    return { ok: true, commitment, workbench: this.getWorkbench(callerDomain) };
  }

  scanCadence(input: {
    quietHoursActive?: boolean;
    calibrationDue?: boolean;
    injectCollisionDemo?: boolean;
    callerDomain?: CallerAccessDomain;
  } = {}): {
    emitNow: ProactiveCandidate[];
    foldToMorningDigest: ProactiveCandidate[];
    suppressedIds: string[];
    workbench: StewardWorkbenchSnapshot;
  } {
    const nowIso = this.nowIsoFn();
    const dateKey = this.currentDateKey(nowIso);
    const { scan, fleetEvents } = this.scanAntigravity();
    const allFleet = [...scan.cadenceEvents, ...fleetEvents];
    if (input.injectCollisionDemo) {
      const sampleProj = scan.sessions[0]?.projectKey ?? "repo:workspace/demo";
      allFleet.unshift({
        id: `demo-red-${crypto.randomBytes(2).toString("hex")}`,
        dedupeKey: `demo_red_collision:${sampleProj}:${dateKey}`,
        kind: "red_collision",
        projectKey: sampleProj,
        nodeId: "remote-vps",
        summary: `远端节点正在同分支 main 并发修改 ${sampleProj}`,
        actionHint: "暂停本机写操作或切独立 worktree 分支避免冲突",
        urgency: "urgent",
        updatedAtIso: nowIso,
      });
    }
    const candidates = scanLedgerImbalances(this.ledger.snapshotForCaller("owner_private"), nowIso, {
      ...(input.calibrationDue ? { calibrationDue: true } : {}),
      fleetPulses: allFleet,
    });
    const gated = this.budgetGate.evaluateAndRecord(
      candidates,
      dateKey,
      Boolean(input.quietHoursActive ?? this.quietHoursActive),
    );
    this.lastCadenceScan = {
      atIso: nowIso,
      emitNow: gated.emitNow,
      foldToMorningDigest: gated.foldToMorningDigest,
      suppressedIds: gated.suppressedIds,
    };
    return {
      emitNow: gated.emitNow,
      foldToMorningDigest: gated.foldToMorningDigest,
      suppressedIds: gated.suppressedIds,
      workbench: this.getWorkbench(input.callerDomain ?? "owner_private"),
    };
  }

  drainMorning(input: { nextDateKey?: string; callerDomain?: CallerAccessDomain } = {}): {
    emitNow: ProactiveCandidate[];
    supersededIds: string[];
    workbench: StewardWorkbenchSnapshot;
  } {
    const nowIso = this.nowIsoFn();
    const nowMs = Date.parse(nowIso) || Date.now();
    const targetDateKey = input.nextDateKey?.trim() || new Date(nowMs + 86_400_000).toISOString().slice(0, 10);
    const closedCommitIds = new Set(
      this.ledger
        .snapshotForCaller("owner_private")
        .commitments.filter((c) => c.status === "closed" || c.status === "superseded")
        .map((c) => c.id),
    );
    const { scan } = this.scanAntigravity();
    const supersededConvIds = new Set(scan.sessions.filter((s) => s.superseded).map((s) => s.conversationId));
    const drained = this.budgetGate.drainMorningDigest(targetDateKey, (c) => {
      const ref = c.targetRefId ?? "";
      return closedCommitIds.has(ref) || supersededConvIds.has(ref);
    });
    this.lastMorningDrain = {
      atIso: nowIso,
      dateKey: targetDateKey,
      emitNow: drained.emitNow,
      supersededIds: drained.supersededIds,
    };
    return {
      emitNow: drained.emitNow,
      supersededIds: drained.supersededIds,
      workbench: this.getWorkbench(input.callerDomain ?? "owner_private"),
    };
  }

  setProjectTier(input: {
    projectKey: string;
    tier: PrivacyTier;
    callerDomain?: CallerAccessDomain;
  }): { policy: ProjectPrivacyPolicy; workbench: StewardWorkbenchSnapshot } {
    const policy = this.privacy.setProjectTier(input.projectKey, input.tier, "user_override");
    return { policy, workbench: this.getWorkbench(input.callerDomain ?? "owner_private") };
  }

  markSessionViewed(input: {
    conversationId: string;
    callerDomain?: CallerAccessDomain;
  }): { ok: true; watermarkMs: number; workbench: StewardWorkbenchSnapshot } {
    const watermarkMs = Date.now() + 60_000;
    this.viewedWatermarks[input.conversationId] = watermarkMs;
    writeJsonAtomic600(this.viewedPath, this.viewedWatermarks);
    return { ok: true, watermarkMs, workbench: this.getWorkbench(input.callerDomain ?? "owner_private") };
  }

  upsertRepoBinding(input: UpsertRepoBindingInput, callerDomain: CallerAccessDomain = "owner_private"): { ok: true; binding: RepoBindingRecord; workbench: StewardWorkbenchSnapshot } {
    const binding = this.repoBindings.upsertBinding(input);
    return { ok: true, binding, workbench: this.getWorkbench(callerDomain) };
  }

  bindSelfRepo(opts: { repoRoot?: string; targetAppBundlePath?: string; pinnedConversationId?: string } = {}, callerDomain: CallerAccessDomain = "owner_private"): { ok: true; binding: RepoBindingRecord; workbench: StewardWorkbenchSnapshot } {
    const binding = this.repoBindings.bindSugentSelfRepo(opts);
    return { ok: true, binding, workbench: this.getWorkbench(callerDomain) };
  }

  removeRepoBinding(bindingId: string, callerDomain: CallerAccessDomain = "owner_private"): { ok: boolean; workbench: StewardWorkbenchSnapshot } {
    const ok = this.repoBindings.removeBinding(bindingId);
    return { ok, workbench: this.getWorkbench(callerDomain) };
  }

  async startVibeTask(input: {
    text: string;
    bindingQuery?: string;
    channel?: VibeIngressChannel;
    peerId?: string;
    filePaths?: string[];
    attachments?: InboundAttachmentInput[];
    pullArchiveQuery?: string;
    allowUnlistedPaths?: boolean;
    useWorktree?: boolean;
    callerDomain?: CallerAccessDomain;
  }): Promise<{ ok: boolean; message: string; needsBindingClarification?: boolean; requiresPathApproval?: boolean; blockedPaths?: string[]; pipeline?: VibePipelineRecord; workbench: StewardWorkbenchSnapshot }> {
    const mappedPaths: InboundAttachmentInput[] = (input.filePaths ?? []).map((p) => ({ sourcePath: p, name: path.basename(p), originTrust: "owner_direct" }));
    const res = await this.vibePipeline.startTask({
      ...input,
      attachments: [...(input.attachments ?? []), ...mappedPaths],
    });
    return { ...res, workbench: this.getWorkbench(input.callerDomain ?? "owner_private") };
  }

  async decideVibeTask(input: {
    pipelineId?: string;
    rawReplyText?: string;
    action?: "approve" | "revise" | "cancel" | "verify_now" | "relaunch_now";
    feedback?: string;
    dryRunRelaunch?: boolean;
    callerDomain?: CallerAccessDomain;
  }): Promise<{ ok: boolean; message: string; pipeline?: VibePipelineRecord; workbench: StewardWorkbenchSnapshot }> {
    const res = await this.vibePipeline.decide(input);
    if (input.action === "verify_now" && res.pipeline) {
      this.adaptiveRouter.recordVibeGateFeedback(res.pipeline.stage !== "failed" && res.pipeline.lastVerification?.passed !== false);
    }
    return { ...res, workbench: this.getWorkbench(input.callerDomain ?? "owner_private") };
  }

  async advanceVibePipeline(input: {
    pipelineId?: string;
    conversationId?: string;
    extraArtifactPaths?: string[];
    changedFilesOverride?: string[];
    callerDomain?: CallerAccessDomain;
  }): Promise<{ ok: boolean; pipeline?: VibePipelineRecord; workbench: StewardWorkbenchSnapshot }> {
    const target = input.pipelineId
      ? this.vibePipeline.getPipeline(input.pipelineId)
      : this.vibePipeline.listPipelines().find((p) => p.conversationId === input.conversationId);
    if (!target) return { ok: false, workbench: this.getWorkbench(input.callerDomain ?? "owner_private") };
    let updated: VibePipelineRecord | undefined;
    if (target.stage === "planning") {
      const comp = target.conversationId ? await this.comprehendSession({ conversationId: target.conversationId, projectKey: target.projectKey, title: target.repoAlias }) : undefined;
      updated = await this.vibePipeline.onHarnessIdle(target.pipelineId, comp);
    } else if (target.stage === "developing") {
      updated = await this.vibePipeline.runVerificationAndPackage(target.pipelineId, { extraArtifactPaths: input.extraArtifactPaths, changedFilesOverride: input.changedFilesOverride });
      if (updated && (updated.stage === "completed" || updated.stage === "awaiting_restart_approval" || updated.stage === "failed" || updated.lastVerification)) {
        this.adaptiveRouter.recordVibeGateFeedback(updated.stage !== "failed" && updated.lastVerification?.passed !== false);
      }
    } else {
      updated = target;
    }
    return { ok: Boolean(updated), ...(updated ? { pipeline: updated } : {}), workbench: this.getWorkbench(input.callerDomain ?? "owner_private") };
  }

  resolveVibeArtifact(pipelineId: string, fileName: string): string | undefined {
    return this.vibePipeline.resolveSafeArtifactPath(pipelineId, fileName);
  }

  async markBootHealthy(pid: number, version: string): Promise<PostBootNotice | undefined> {
    const nowMs = Date.now();
    writeBootHealthyStamp(this.opts.dataDir, { pid, version, startedAtMs: nowMs, startedAtIso: new Date(nowMs).toISOString() });
    const notice = this.relauncher.reconcilePostBootTransaction(this.nowIsoFn());
    if (notice) {
      this.lastBootNotice = notice;
      await this.vibePipeline.reconcileBootOutcome(notice);
    }
    return notice;
  }

  private getAuthorizedProjectRoots(scanOverride?: AntigravityScanResult): AuthorizedProjectRoot[] {
    const byPath = new Map<string, AuthorizedProjectRoot>();
    for (const r of discoverConfigProjectRoots(this.homeDir)) {
      byPath.set(path.resolve(r.rootPath), r);
    }
    const scan = scanOverride ?? this.lastScanResult ?? this.scanAntigravity().scan;
    for (const s of scan.sessions) {
      if (!s.workspaceRoot) continue;
      const p = path.resolve(s.workspaceRoot);
      if (!byPath.has(p) && fs.existsSync(p)) {
        byPath.set(p, {
          projectKey: s.projectKey,
          displayName: s.projectDisplayName || path.basename(p),
          rootPath: p,
          sourceKind: "project_workspace",
        });
      }
    }
    for (const b of this.repoBindings.listBindings()) {
      const p = path.resolve(b.repoRoot);
      if (!byPath.has(p) && fs.existsSync(p)) {
        byPath.set(p, {
          projectKey: b.projectKey,
          displayName: b.alias,
          rootPath: p,
          sourceKind: "bound_repo",
        });
      }
    }
    return Array.from(byPath.values());
  }

  searchAuthorizedFiles(input: { query?: string; projectQuery?: string; conversationId?: string; callerDomain?: CallerAccessDomain; limit?: number } = {}): AuthorizedFileMatch[] {
    return this.authorizedFiles.searchFiles(input);
  }

  readAuthorizedFile(input: { filePath?: string; fileQuery?: string; projectQuery?: string; conversationId?: string; offsetChars?: number; maxChars?: number; callerDomain?: CallerAccessDomain }): ReadAuthorizedFileResult {
    return this.authorizedFiles.readFile(input);
  }

  getCapabilitySnapshot(): CapabilityAwarenessSnapshot {
    return this.capabilityAwareness.snapshot(this.getAuthorizedProjectRoots().length);
  }

  evaluateFlowCadence(input: {
    flow: OwnerFlowContext;
    quietHoursActive?: boolean;
    calibrationDue?: boolean;
    callerDomain?: CallerAccessDomain;
  }): {
    emitNow: ProactiveCandidate[];
    holdForBoundary: ProactiveCandidate[];
    foldToMorningDigest: ProactiveCandidate[];
    suppressedIds: string[];
    workbench: StewardWorkbenchSnapshot;
  } {
    const nowIso = this.nowIsoFn();
    const dateKey = this.currentDateKey(nowIso);
    const { scan, fleetEvents } = this.scanAntigravity();
    const candidates = scanLedgerImbalances(this.ledger.snapshotForCaller("owner_private"), nowIso, {
      ...(input.calibrationDue ? { calibrationDue: true } : {}),
      fleetPulses: [...scan.cadenceEvents, ...fleetEvents],
    });
    const res = this.budgetGate.evaluateFlowAndRecord(
      candidates,
      dateKey,
      Boolean(input.quietHoursActive ?? this.quietHoursActive),
      input.flow,
      nowIso,
    );
    return {
      emitNow: res.emitNow,
      holdForBoundary: res.holdForBoundary,
      foldToMorningDigest: res.foldToMorningDigest,
      suppressedIds: res.suppressedIds,
      workbench: this.getWorkbench(input.callerDomain ?? "owner_private"),
    };
  }

  drainFlowBoundary(input: { callerDomain?: CallerAccessDomain } = {}): {
    emitNow: ProactiveCandidate[];
    supersededIds: string[];
    workbench: StewardWorkbenchSnapshot;
  } {
    const nowIso = this.nowIsoFn();
    const dateKey = this.currentDateKey(nowIso);
    const closedCommitIds = new Set(
      this.ledger
        .snapshotForCaller("owner_private")
        .commitments.filter((c) => c.status === "closed" || c.status === "superseded")
        .map((c) => c.id),
    );
    const { scan } = this.scanAntigravity();
    const supersededConvIds = new Set(scan.sessions.filter((s) => s.superseded).map((s) => s.conversationId));
    const drained = this.budgetGate.drainBoundaryQueueForDate(dateKey, (c) => {
      const ref = c.targetRefId ?? "";
      return closedCommitIds.has(ref) || supersededConvIds.has(ref);
    });
    return {
      emitNow: drained.emitNow,
      supersededIds: drained.supersededIds,
      workbench: this.getWorkbench(input.callerDomain ?? "owner_private"),
    };
  }

  runGardener(
    partial: Partial<Omit<GardenerCycleInput, "nowIso" | "ledger" | "recentRounds">> = {},
  ): GardenerCycleOutput {
    const nowIso = this.nowIsoFn();
    return runGardenerCycle({
      nowIso,
      ledger: this.ledger.snapshotForCaller("owner_private"),
      recentRounds: this.causalLedger.listRounds(),
      hypotheses: partial.hypotheses ?? [],
      sandboxEvents: partial.sandboxEvents,
      activeEdges: partial.activeEdges ?? this.opts.knowledgeGraph.activeEdges(),
      ruleStats: partial.ruleStats,
      recentMessagesByPeer: partial.recentMessagesByPeer,
      prevSurpriseMomentum: partial.prevSurpriseMomentum ?? 0,
      currentSurprise: partial.currentSurprise,
      maxStewardTokenBudget: partial.maxStewardTokenBudget ?? 1024,
      windowDays: partial.windowDays,
    });
  }

  getHotUpdateStatus(): Record<string, unknown> {
    return this.opts.hotUpdatePort?.getStatus() ?? { supervised: false };
  }

  triggerHotReloadUi(file?: string): Record<string, unknown> {
    return this.opts.hotUpdatePort?.reloadUi(file) ?? { ok: false, error: "HOT_UPDATE_UNAVAILABLE" };
  }

  async triggerHotReloadCore(opts?: { reason?: string }): Promise<Record<string, unknown>> {
    if (!this.opts.hotUpdatePort) return { ok: false, error: "HOT_UPDATE_UNAVAILABLE" };
    return this.opts.hotUpdatePort.reloadCore(opts);
  }

  async stageHotBundle(bundleBase64: string, opts?: { allowUnsigned?: boolean }): Promise<Record<string, unknown>> {
    if (!this.opts.hotUpdatePort) return { ok: false, error: "HOT_UPDATE_UNAVAILABLE" };
    return this.opts.hotUpdatePort.stageBundle(bundleBase64, opts);
  }

  async rollbackHotSlot(): Promise<Record<string, unknown>> {
    if (!this.opts.hotUpdatePort) return { ok: false, error: "HOT_UPDATE_UNAVAILABLE" };
    return this.opts.hotUpdatePort.rollbackSlot();
  }

  async factoryResetHotSlot(): Promise<Record<string, unknown>> {
    if (!this.opts.hotUpdatePort) return { ok: false, error: "HOT_UPDATE_UNAVAILABLE" };
    return this.opts.hotUpdatePort.factoryReset();
  }

  async executeHotUpdateAction(input: {
    action: "status" | "reload_ui" | "reload_core" | "rollback" | "factory_reset";
    file?: string;
    reason?: string;
  }): Promise<Record<string, unknown>> {
    if (input.action === "status") return this.getHotUpdateStatus();
    if (input.action === "reload_ui") return this.triggerHotReloadUi(input.file);
    if (input.action === "reload_core") return this.triggerHotReloadCore({ reason: input.reason });
    if (input.action === "rollback") return this.rollbackHotSlot();
    if (input.action === "factory_reset") return this.factoryResetHotSlot();
    return { ok: false, error: `UNKNOWN_ACTION:${String(input.action)}` };
  }

  listSkillCandidates(threshold = 3): { ok: true; candidates: SkillCandidateSummary[]; skillsRootDir: string } {
    const skillsRootDir = path.join(this.opts.dataDir, "skills");
    return {
      ok: true,
      candidates: this.opts.knowledgeGraph.listSkillCandidates({ threshold }),
      skillsRootDir,
    };
  }

  decideSkillCandidate(input: {
    nodeId: string;
    decision: "approve" | "reject";
    maxActiveSkills?: number;
    threshold?: number;
  }): {
    ok: boolean;
    nodeId: string;
    decision: "approve" | "reject";
    crystallizedPaths: string[];
    candidates: SkillCandidateSummary[];
  } {
    const nodeId = String(input.nodeId ?? "").trim();
    const ok =
      input.decision === "approve"
        ? this.opts.knowledgeGraph.approveSkillCandidate(nodeId)
        : this.opts.knowledgeGraph.rejectSkillCandidate(nodeId);
    const skillsRootDir = path.join(this.opts.dataDir, "skills");
    const crystallizedPaths = ok
      ? this.opts.knowledgeGraph.crystallizeSkillsToDir(skillsRootDir, {
          gated: true,
          maxActiveSkills: input.maxActiveSkills ?? 12,
          threshold: input.threshold ?? 3,
        })
      : [];
    return {
      ok,
      nodeId,
      decision: input.decision,
      crystallizedPaths,
      candidates: this.opts.knowledgeGraph.listSkillCandidates({ threshold: input.threshold ?? 3 }),
    };
  }

  private readPulseState(): { lastMorningDateKey?: string; lastGardenerAtMs?: number; prevSurpriseMomentum?: number } {
    try {
      if (!fs.existsSync(this.pulseStatePath)) return {};
      const raw = JSON.parse(fs.readFileSync(this.pulseStatePath, "utf8")) as Record<string, unknown>;
      return {
        ...(typeof raw.lastMorningDateKey === "string" ? { lastMorningDateKey: raw.lastMorningDateKey } : {}),
        ...(typeof raw.lastGardenerAtMs === "number" ? { lastGardenerAtMs: raw.lastGardenerAtMs } : {}),
        ...(typeof raw.prevSurpriseMomentum === "number" ? { prevSurpriseMomentum: raw.prevSurpriseMomentum } : {}),
      };
    } catch {
      return {};
    }
  }

  runScheduledPulse(input: {
    nowMs?: number;
    forceMorningDrain?: boolean;
    drainBoundary?: boolean;
    forceGardener?: boolean;
    gardenerIntervalMs?: number;
  } = {}): {
    atIso: string;
    dateKey: string;
    scan: { emitNow: ProactiveCandidate[]; foldToMorningDigest: ProactiveCandidate[]; suppressedIds: string[] };
    morningDrain?: { emitNow: ProactiveCandidate[]; supersededIds: string[] };
    boundaryDrain?: { emitNow: ProactiveCandidate[]; supersededIds: string[] };
    gardener?: GardenerCycleOutput;
  } {
    const nowMs = input.nowMs ?? (Date.parse(this.nowIsoFn()) || Date.now());
    const nowDate = new Date(nowMs);
    const atIso = nowDate.toISOString();
    const dateKey = atIso.slice(0, 10);
    const localDateKey = `${nowDate.getFullYear()}-${String(nowDate.getMonth() + 1).padStart(2, "0")}-${String(nowDate.getDate()).padStart(2, "0")}`;
    const localHour = nowDate.getHours();
    const state = this.readPulseState();

    let morningDrain: { emitNow: ProactiveCandidate[]; supersededIds: string[] } | undefined;
    const inMorningWindow = localHour >= 7 && localHour < 11;
    if (input.forceMorningDrain || (inMorningWindow && state.lastMorningDateKey !== localDateKey)) {
      const drained = this.drainMorning({ nextDateKey: localDateKey });
      morningDrain = { emitNow: drained.emitNow, supersededIds: drained.supersededIds };
      state.lastMorningDateKey = localDateKey;
    }

    let boundaryDrain: { emitNow: ProactiveCandidate[]; supersededIds: string[] } | undefined;
    if (input.drainBoundary !== false && !this.quietHoursActive) {
      const bDrained = this.drainFlowBoundary();
      if (bDrained.emitNow.length > 0 || bDrained.supersededIds.length > 0) {
        boundaryDrain = { emitNow: bDrained.emitNow, supersededIds: bDrained.supersededIds };
      }
    }

    const scanned = this.scanCadence();
    const scan = {
      emitNow: scanned.emitNow,
      foldToMorningDigest: scanned.foldToMorningDigest,
      suppressedIds: scanned.suppressedIds,
    };

    let gardener: GardenerCycleOutput | undefined;
    const gardenerIntervalMs = Math.max(60_000, input.gardenerIntervalMs ?? 7 * 86_400_000);
    if (input.forceGardener || !state.lastGardenerAtMs || nowMs - state.lastGardenerAtMs >= gardenerIntervalMs) {
      gardener = this.runGardener({ prevSurpriseMomentum: state.prevSurpriseMomentum ?? 0 });
      state.lastGardenerAtMs = nowMs;
      state.prevSurpriseMomentum = gardener.driftReport.surpriseMomentum;
    }

    writeJsonAtomic600(this.pulseStatePath, state);
    return {
      atIso,
      dateKey,
      scan,
      ...(morningDrain ? { morningDrain } : {}),
      ...(boundaryDrain ? { boundaryDrain } : {}),
      ...(gardener ? { gardener } : {}),
    };
  }

  setRemoteOpsSnapshot(snapshot: OpsStewardPendingSnapshot | undefined): void {
    this.remoteOpsSnapshot = snapshot;
    this.stagedOpsInbox.clear();
    if (snapshot?.pendingInbox) {
      for (const item of snapshot.pendingInbox) {
        if (item?.id) this.stagedOpsInbox.set(item.id, item);
      }
    }
  }

  getRemoteOpsSnapshot(): OpsStewardPendingSnapshot | undefined {
    return this.getMergedOpsFleetSnapshot();
  }

  getMergedOpsFleetSnapshot(): OpsStewardPendingSnapshot | undefined {
    const edgeSnap = this.edgeHub.toOpsStewardSnapshot();
    const hasEdge = edgeSnap.projects.length > 0 || this.edgeHub.listNodes().length > 0;
    if (!hasEdge && !this.remoteOpsSnapshot) return undefined;
    if (!this.remoteOpsSnapshot) {
      return {
        ...edgeSnap,
        pendingInbox: Array.from(this.stagedOpsInbox.values()),
      };
    }
    if (!hasEdge) return this.remoteOpsSnapshot;

    const laneRank: Record<string, number> = {
      blocked: 1,
      active_executing: 2,
      pending_review: 3,
      monitoring: 4,
      planned_ready: 5,
      idle_untracked: 6,
    };
    const stageRank: Record<string, number> = {
      focus: 1,
      autopilot: 2,
      incubating: 3,
      archived: 4,
    };

    const byKey = new Map<string, OpsStewardPendingSnapshot["projects"][number]>();
    for (const p of this.remoteOpsSnapshot.projects) {
      if (p?.projectKey) byKey.set(p.projectKey, p);
    }
    for (const ep of edgeSnap.projects) {
      if (!ep?.projectKey) continue;
      const prev = byKey.get(ep.projectKey);
      if (!prev) {
        byKey.set(ep.projectKey, ep);
        continue;
      }
      const combinedNodes = Array.from(
        new Set([...(prev.nodes ?? (prev.nodeId ? [prev.nodeId] : [])), ...(ep.nodes ?? (ep.nodeId ? [ep.nodeId] : []))]),
      );
      const keepUserDomain = prev.domainSource === "user_override" && Boolean(prev.domain);
      const keepUserStage = prev.stageSource === "user_override" && Boolean(prev.stage);
      const keepUserBoard = prev.boardStatusSource === "user_override" && Boolean(prev.boardStatus);
      const isRunning = ep.status === "running" || prev.status === "running";
      byKey.set(ep.projectKey, {
        ...prev,
        ...ep,
        nodes: combinedNodes,
        status: isRunning ? "running" : (ep.status ?? prev.status),
        ...(keepUserDomain ? { domain: prev.domain, domainSource: "user_override" } : {}),
        ...(keepUserStage ? { stage: prev.stage, stageSource: "user_override" } : {}),
        ...(keepUserBoard
          ? { boardStatus: prev.boardStatus, boardStatusReason: prev.boardStatusReason, boardStatusSource: "user_override" }
          : isRunning && ep.boardStatus !== "blocked" && prev.boardStatus !== "blocked"
            ? { boardStatus: "active_executing", boardStatusReason: "当前存在活跃运行中的会话" }
            : {}),
        statusCard: ep.statusCard ?? prev.statusCard,
        roadmapSummary: ep.roadmapSummary ?? prev.roadmapSummary,
        executiveSummary: ep.executiveSummary ?? prev.executiveSummary,
      });
    }
    const mergedProjects = Array.from(byKey.values()).sort((a, b) => {
      const runDiff = Number(b.status === "running") - Number(a.status === "running");
      if (runDiff !== 0) return runDiff;
      const lDiff = (laneRank[a.boardStatus ?? "idle_untracked"] ?? 6) - (laneRank[b.boardStatus ?? "idle_untracked"] ?? 6);
      if (lDiff !== 0) return lDiff;
      const sDiff = (stageRank[a.stage ?? "incubating"] ?? 3) - (stageRank[b.stage ?? "incubating"] ?? 3);
      if (sDiff !== 0) return sDiff;
      const msA = Date.parse(a.lastActiveAt ?? a.updatedAtIso ?? "") || 0;
      const msB = Date.parse(b.lastActiveAt ?? b.updatedAtIso ?? "") || 0;
      return msB - msA;
    });
    return {
      fetchedAtIso: edgeSnap.fetchedAtIso ?? this.remoteOpsSnapshot.fetchedAtIso,
      projects: mergedProjects,
      pendingInbox:
        this.remoteOpsSnapshot.pendingInbox.length > 0
          ? this.remoteOpsSnapshot.pendingInbox
          : Array.from(this.stagedOpsInbox.values()),
      ...(this.remoteOpsSnapshot.weeklyFocus ? { weeklyFocus: this.remoteOpsSnapshot.weeklyFocus } : {}),
      ...(edgeSnap.stageGoals ?? this.remoteOpsSnapshot.stageGoals
        ? { stageGoals: edgeSnap.stageGoals ?? this.remoteOpsSnapshot.stageGoals }
        : {}),
    };
  }

  ingestEdgeNodePulse(input: EdgeIngestPulseInput) {
    return this.edgeHub.ingestNodePulse(input);
  }

  recallChatHistory(input: RecallChatHistoryInput = {}): ChatHistoryRecallResult {
    return this.chatRecall.recallChatHistory(input);
  }

  dispatchEdgeAntigravity(input: {
    targetNodeId?: string;
    mode?: "new" | "resume";
    title: string;
    prompt: string;
    projectQuery?: string;
    conversationId?: string;
    workspaceHint?: string;
  }): { ok: boolean; command: EdgeQueuedCommand; nodes: EdgeNodeStatus[]; message: string } {
    const fleet = this.getMergedOpsFleetSnapshot();
    const q = String(input.projectQuery ?? "").trim().toLowerCase();
    const matchedProj = q
      ? fleet?.projects.find((p) => `${p.displayName ?? ""} ${p.projectKey}`.toLowerCase().includes(q))
      : undefined;
    const targetNodeId =
      input.targetNodeId?.trim() ||
      matchedProj?.nodeId ||
      matchedProj?.nodes?.[0] ||
      this.edgeHub.listNodes().find((n) => n.online)?.nodeId ||
      "local-mac";
    const action = input.mode === "resume" && input.conversationId ? "dispatch_antigravity_resume" : "dispatch_antigravity_new";
    const command = this.edgeHub.enqueueCommand({
      targetNodeId,
      action,
      title: input.title,
      prompt: input.prompt,
      summary: input.prompt.slice(0, 200),
      ...(matchedProj?.projectKey ? { projectKey: matchedProj.projectKey } : (input.projectQuery ? { projectKey: input.projectQuery } : {})),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.workspaceHint ? { workspaceHint: input.workspaceHint } : (matchedProj?.displayName ? { workspaceHint: matchedProj.displayName } : {})),
    });
    const nodes = this.edgeHub.listNodes();
    const targetOnline = nodes.some((n) => n.nodeId === targetNodeId && n.online);
    return {
      ok: true,
      command,
      nodes,
      message: targetOnline
        ? `已将编码任务「${command.title}」派发至在线触手节点 ${targetNodeId}（指令号 ${command.id}），完工后将通过微信推送回执。`
        : `已将编码任务「${command.title}」挂入节点 ${targetNodeId} 队列（指令号 ${command.id}）；该节点当前离线，唤醒联网后将自动拉取执行。`,
    };
  }

  async refreshRemoteOpsSnapshot(): Promise<{
    ok: boolean;
    configured: boolean;
    snapshot?: OpsStewardPendingSnapshot;
    reason?: string;
  }> {
    const bridge = this.opts.opsBridge;
    if (!bridge || !bridge.isConfigured()) {
      const merged = this.getMergedOpsFleetSnapshot();
      if (merged) {
        return { ok: true, configured: true, snapshot: merged };
      }
      return { ok: false, configured: this.edgeHub.hasConfiguredTokens(), snapshot: undefined, reason: "OPS_BRIDGE_UNCONFIGURED" };
    }
    const res = await bridge.fetchFleetSnapshot();
    if (res.ok && res.snapshot) {
      this.setRemoteOpsSnapshot(res.snapshot);
      return { ok: true, configured: true, snapshot: this.getMergedOpsFleetSnapshot() ?? res.snapshot };
    }
    const fallback = this.getMergedOpsFleetSnapshot();
    return { ok: Boolean(fallback), configured: true, snapshot: fallback, ...(res.reason ? { reason: res.reason } : {}) };
  }

  stageOpsInboxProposal(item: OpsInboxItem): void {
    if (!item?.id) return;
    this.stagedOpsInbox.set(item.id, item);
  }

  async proposeOpsInbox(input: {
    title: string;
    summary?: string;
    targetNodeId?: string;
    commandAction?: string;
    projectKey?: string;
    requiresDashboardConfirm?: boolean;
    weeklyFocus?: string[];
  }): Promise<Record<string, unknown>> {
    const id = `inb-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`;
    const highRiskText = `${input.title} ${input.summary ?? ""}`;
    const highRisk = Boolean(
      input.requiresDashboardConfirm ||
        /(资金|转账|付款|打款|合同|签约|协议|对外发言|公开发布|群发)/.test(highRiskText),
    );
    const item: OpsInboxItem = {
      id,
      title: input.title,
      ...(input.summary ? { summary: input.summary } : {}),
      targetNodeId: input.targetNodeId || "local-mac",
      commandAction: input.commandAction || "sync_weekly_plan",
      ...(input.projectKey ? { projectKey: input.projectKey } : {}),
      requiresDashboardConfirm: highRisk,
      createdAtIso: this.nowIsoFn(),
    };
    this.stageOpsInboxProposal(item);
    if (this.remoteOpsSnapshot) {
      this.remoteOpsSnapshot = {
        ...this.remoteOpsSnapshot,
        pendingInbox: [item, ...this.remoteOpsSnapshot.pendingInbox],
        ...(input.weeklyFocus?.length ? { weeklyFocus: input.weeklyFocus } : {}),
      };
    }
    if (this.opts.opsBridge?.isConfigured() && this.opts.opsBridge.isStewardHub()) {
      const syncRes = await this.opts.opsBridge.stewardSync({
        inboxItems: [item],
        ...(input.weeklyFocus?.length ? { weeklyFocus: input.weeklyFocus } : {}),
      });
      if (!syncRes.ok) {
        return {
          ok: false,
          inboxId: id,
          errorCode: syncRes.reason ?? "OPS_SYNC_FAILED",
          message: `草案已暂存本机，但同步 /ops 失败（${syncRes.reason ?? "network_error"}）。`,
        };
      }
    }
    return {
      ok: true,
      inboxId: id,
      item,
      confirmInstruction: highRisk
        ? `该事项涉及资金/合同/对外发言高风险边界，请前往 /ops 看板二次确认（编号 ${id}）。`
        : `回复「同意」或「/ok ${id}」即可签批并下发至 ${item.targetNodeId}。`,
    };
  }

  collectLocalOpsProjectPulses(): OpsProjectPulseInput[] {
    const nowIso = this.nowIsoFn();
    const { scan } = this.scanAntigravity();
    const sortedSessions = [...scan.sessions].sort(
      (a, b) =>
        ((b.isRunning ? 1 : 0) - (a.isRunning ? 1 : 0)) ||
        ((b.effectiveLastModifiedMs ?? b.lastModifiedMs ?? 0) - (a.effectiveLastModifiedMs ?? a.lastModifiedMs ?? 0)),
    );
    return this.buildProjectViews(sortedSessions).map((p) => ({
      projectKey: p.projectKey,
      displayName: p.displayName,
      aliases: p.aliases,
      tier: p.policy.tier,
      status: p.runningSessionCount > 0 ? "running" : "idle",
      summary: p.title,
      updatedAtIso: nowIso,
      sessionCount: p.sessionCount,
      runningSessionCount: p.runningSessionCount,
      subagentCount: p.subagentCount,
      ...(p.workspaceRoot ? { workspaceRoot: p.workspaceRoot } : {}),
      runningSessions: p.runningSessions,
    }));
  }

  async approveOpsInbox(approvalId?: string): Promise<{ ok: boolean; handled: boolean; reply?: string }> {
    const candidates = Array.from(this.stagedOpsInbox.values());
    const trimmedId = String(approvalId ?? "").trim();
    let target: OpsInboxItem | undefined;

    if (trimmedId) {
      target = this.stagedOpsInbox.get(trimmedId) ?? candidates.find((c) => c.id === trimmedId);
      if (!target) {
        return {
          ok: false,
          handled: true,
          reply: `未找到待签批事项「${trimmedId}」，可能已完成或已过期。`,
        };
      }
    } else {
      if (candidates.length === 0) {
        return { ok: false, handled: false };
      }
      if (candidates.length > 1) {
        const list = candidates.slice(0, 5).map((c) => `${c.id}（${c.title}）`).join("、");
        return {
          ok: false,
          handled: true,
          reply: `当前有 ${candidates.length} 条待签批派单，请附带编号确认（例如 /ok ${candidates[0]!.id}）：${list}`,
        };
      }
      target = candidates[0];
    }

    if (!target) return { ok: false, handled: false };
    if (target.requiresDashboardConfirm) {
      return {
        ok: false,
        handled: true,
        reply: `事项「${target.title}」（${target.id}）涉及高危变更，需前往 /ops 面板完成二次确认。`,
      };
    }

    const cmd: OpsRemoteCommand = {
      id: `cmd-${target.id}-${Date.now().toString(36)}`,
      targetNodeId: target.targetNodeId || "local-mac",
      action: target.commandAction || "execute_approved_inbox",
      title: target.title,
      ...(target.summary ? { summary: target.summary } : {}),
      ...(target.projectKey ? { projectKey: target.projectKey } : {}),
      createdAtIso: this.nowIsoFn(),
    };

    this.edgeHub.enqueueCommand({
      targetNodeId: cmd.targetNodeId,
      action: "execute_approved_inbox",
      title: target.title,
      ...(target.summary ? { prompt: target.summary, summary: target.summary } : {}),
      ...(target.projectKey ? { projectKey: target.projectKey } : {}),
      createdAtIso: cmd.createdAtIso,
    });

    if (this.opts.opsBridge?.isConfigured() && this.opts.opsBridge.isStewardHub()) {
      const syncRes = await this.opts.opsBridge.stewardSync({
        approvedInboxIds: [target.id],
        commands: [cmd],
      });
      if (!syncRes.ok) {
        return {
          ok: false,
          handled: true,
          reply: `签批「${target.title}」（${target.id}）同步 /ops 失败（${syncRes.reason ?? "network_error"}），请稍后重试。`,
        };
      }
    }

    this.stagedOpsInbox.delete(target.id);
    if (this.remoteOpsSnapshot) {
      this.remoteOpsSnapshot = {
        ...this.remoteOpsSnapshot,
        pendingInbox: this.remoteOpsSnapshot.pendingInbox.filter((i) => i.id !== target.id),
      };
    }

    return {
      ok: true,
      handled: true,
      reply: `已签批「${target.title}」（${target.id}），指令已写入队列并下发至节点 ${cmd.targetNodeId}。`,
    };
  }

  getColdStartStatus(): ColdStartReadinessReport {
    return probeColdStartReadiness({
      ledger: this.ledger,
      hasLiveLlm: this.hasLiveLlmEndpoint(),
    });
  }

  ingestColdStart(input: { folderPath?: string; forwardedText?: string; partition?: ContextPartition }) {
    return ingestColdStartDrop({
      ledger: this.ledger,
      suspendedStore: this.suspendedStore,
      ...(input.folderPath ? { folderPath: input.folderPath } : {}),
      ...(input.forwardedText ? { forwardedText: input.forwardedText } : {}),
      ...(input.partition ? { partition: input.partition } : {}),
      nowIso: this.nowIsoFn(),
    });
  }

  completeColdStartDemo(roundId: string, approved: boolean) {
    return completeColdStartApprovalDemo({
      suspendedStore: this.suspendedStore,
      ledger: this.ledger,
      roundId,
      approved,
      nowIso: this.nowIsoFn(),
    });
  }

  setPowerGuardMode(mode: PowerGuardMode, durationMs?: number): PowerGuardStatus {
    return this.powerGuard.enable(mode, durationMs !== undefined ? { durationMs } : undefined);
  }

  getPowerGuardStatus(): PowerGuardStatus {
    return this.powerGuard.getStatus();
  }

  buildOfflineDigest(dueSoonHours = 48): OfflineLedgerDigest {
    return buildOfflineLedgerDigest(this.ledger, { nowIso: this.nowIsoFn(), dueSoonHours });
  }

  briefForwardedWeixinChat(input: {
    rawForwardedText: string;
    ownerName?: string;
  }): ThreeSecondForwardedBriefingResult {
    return buildThreeSecondForwardedBriefing({
      workspaceDir: path.join(this.opts.dataDir, "sugent-stewardship", "weixin-briefings"),
      ledger: this.ledger,
      rawForwardedText: input.rawForwardedText,
      ...(input.ownerName ? { ownerName: input.ownerName } : {}),
    });
  }

  listBuiltinWeaponPackages(): WeaponPackageManifest[] {
    return listWeaponPackages();
  }

  runIndustrialFdePack(input: {
    batchId: string;
    records: IndustrialExceptionRecord[];
    coworkWorkspaceId?: string;
    proposerId?: string;
  }): IndustrialFdeDiagnosticResult {
    return runIndustrialFdeDiagnosticPack({
      workspaceDir: path.join(this.opts.dataDir, "sugent-weapons", "fde-batches"),
      batchId: input.batchId,
      records: input.records,
      ...(input.coworkWorkspaceId ? { coworkWorkspaceId: input.coworkWorkspaceId } : {}),
      ...(input.proposerId ? { proposerId: input.proposerId } : {}),
      nowIso: this.nowIsoFn(),
    });
  }

  runContractGuardPack(input: {
    inquiryId: string;
    counterparty: string;
    rawContractText: string;
    quotedUnitPrice?: number;
    requestedPaymentDays?: number;
  }): RedlineDiffCard {
    return runContractQuoteGuardPack({
      workspaceDir: path.join(this.opts.dataDir, "sugent-weapons", "contract-reviews"),
      inquiryId: input.inquiryId,
      counterparty: input.counterparty,
      rawContractText: input.rawContractText,
      ...(input.quotedUnitPrice !== undefined ? { quotedUnitPrice: input.quotedUnitPrice } : {}),
      ...(input.requestedPaymentDays !== undefined ? { requestedPaymentDays: input.requestedPaymentDays } : {}),
      ledger: this.ledger,
      nowIso: this.nowIsoFn(),
    });
  }

  getWeaponSoakProof(targetSoakDays = 14): CommercialProofSummary {
    return this.weaponSoakLedger.exportCommercialProofSummary(targetSoakDays);
  }
}
