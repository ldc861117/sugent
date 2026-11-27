import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveConfigFile, type AppConfig } from "./config.js";
import { Store, type Bot, type ChannelAccount } from "./store/db.js";
import { OpenAICompatClient, type ModelClient } from "./llm/client.js";
import { BotRuntime } from "./core/runtime.js";
import { KeyedQueue } from "./core/queue.js";
import { deferNotice, interruptedText, takeInterrupted, type Interrupted } from "./core/recovery.js";
import { Outbox } from "./core/outbox.js";
import { Delivery, type DeliveryOptions } from "./core/delivery.js";
import { AccessControl } from "./core/access.js";
import { MESSENGERS, MESSENGER_LABEL, isMessenger, type ChannelStatus, type MessengerId } from "./core/types.js";
import { botForPeer, defaultBotFor } from "./core/routes.js";
import { MagpieSupervisor, findAppRoot } from "./magpie/supervisor.js";
import { FeishuChannel } from "./channels/feishu/channel.js";
import { LarkTransport, type FeishuTransport } from "./channels/feishu/transport.js";
import { WeixinChannel } from "./channels/weixin/channel.js";
import { WeixinLogin } from "./channels/weixin/login.js";
import { MessengerChannel } from "./channels/messenger/channel.js";
import { MESSENGER_FIELDS, createTransport, telegramOffsetKey } from "./channels/messenger/index.js";
import { PlatformError, type MessengerTransport } from "./channels/messenger/transport.js";
import { startWebServer, type WebServer } from "./web/server.js";
import { initFileLog, logFilePath, logger, mask, registerSecret } from "./log.js";
import { AgentManager } from "./agent/manager.js";
import { normalizeSettings } from "./agent/settings.js";
import { locateDshRuntime } from "./agent/host.js";
import { pwshProbe } from "./agent/pwsh.js";
import {
  MODELFLARE_LINES,
  MODELFLARE_PROVIDER,
  bareModel,
  botProviderId,
  fetchKeyBalance,
  modelflareBaseUrl,
  modelflareIssuer,
  routeModel,
  skillHeader,
  verifyModelflareKey,
  type ModelflareLine,
  type VerifyResult,
} from "./modelflare.js";
import { AccountManager } from "./account/manager.js";
import { AccountVault, type SecretBox } from "./account/vault.js";
import { loadModelInfo, type ModelInfo, type Rates } from "./account/model-info.js";
import { MediaService, pickDefault } from "./agent/media.js";
import { SearchService, loadWebSearch, saveWebSearch, type SearchProvider, type WebSearchSettings, type WebSearchView } from "./agent/search.js";
import { ConnectionService } from "./agent/connections.js";
import { COMPACT_ENDPOINT, serverCompactionEnabled, type CompactEndpoint } from "./agent/server-compaction.js";
import type { BotSettings } from "./agent/settings.js";
import { TaskService } from "./tasks/service.js";
import { RuleEvents } from "./tasks/rule-events.js";
import { lockDataDir, type DataDirLock } from "./store/lock.js";
import { detached, setLangPref, t, t as tr } from "./i18n/index.js";
import { Attention, approvalItems, deliveryItem, type AttentionItem } from "./tasks/attention.js";
import {
  ChatTranscriptRecallService,
  ConciergeChannelBridge,
  HotBundleSlotManager,
  HotReloadBus,
  LLM_PROVIDER_PRESETS,
  LocalBudgetLedger,
  OpsBridgeClient,
  OwnerChannelStewardRouter,
  ProviderRegistry,
  SugentAuthManager,
  SugentKnowledgeGraph,
  SugentModelCatalog,
  SugentP2HostService,
  SugentStewardHostService,
  buildBrokerDesktopAuthConfig,
  createEnvelopedRuleEventSink,
  decodeJwtPayloadUnsafe,
  deriveMagpieApiBases,
  evaluateWeixinSingleHolderGuard,
  normalizeProviderPresetId,
  probeGeminiWeb2Api,
  resolveOpsBridgeConfig,
  resolveSugentGatewayConfig,
  resolveUnifiedKnowledgeGraphDir,
  type GeminiWeb2ApiProbeResult,
  type ProviderSyncResult,
  type PublicProviderItem,
  type SugentAuthConfig,
  type SugentAuthConfigPatch,
  type SugentBrokerClaims,
  type SugentRoleKey,
  type UpsertProviderInput,
  type WeixinSingleHolderVerdict,
} from "./sugent/index.js";

const log = logger("app");

export interface DesktopHooks {
  autostart(): { supported: boolean; on: boolean };
  setAutostart(on: boolean): void;
  applyZoom(zoom: number): void;
  setTitleBarTheme?(dark: boolean): void;
  openDataDir(): void;
  openPath?(p: string): void;
  showItemInFolder?(p: string): void;
  openInBrowser(): void;
  openExternal(url: string): void;
  secretBox?: SecretBox;
  fetch?: typeof fetch;
  resolveProxy?(url: string): Promise<string>;
  updateStatus?(): DesktopUpdateStatus;
  downloadUpdate?(): DesktopUpdateStatus;
  installUpdate?(): void;
  requestRelaunchQuit?(): void;
  companionState?(): { supported: boolean; visible: boolean; expanded: boolean; dockEdge?: string; facing?: string; dockMode?: string };
  toggleCompanion?(visible?: boolean): { supported: boolean; visible: boolean; expanded: boolean; dockEdge?: string; facing?: string; dockMode?: string };
  showCompanionQuickBar?(): { supported: boolean; visible: boolean; expanded: boolean; dockEdge?: string; facing?: string; dockMode?: string };
  notifyCompanion?: (payload: Record<string, unknown>) => void;
  handoffCompanionToMain?: (payload: { hash?: string; draftText?: string; source?: string }) => void;
  hotUpdateStatus?(): Record<string, unknown>;
  requestHotReloadCore?(opts?: { reason?: string }): Promise<{ ok: boolean; rolledBack?: boolean; elapsedMs?: number; bootId?: string; error?: string }>;
  requestStageHotBundle?(bundleBase64: string, opts?: { allowUnsigned?: boolean }): Promise<{ ok: boolean; slot?: string; rolledBack?: boolean; error?: string }>;
  requestRollbackHotSlot?(): Promise<{ ok: boolean; activeSlot?: string | null; error?: string }>;
  requestFactoryResetHotSlot?(): Promise<{ ok: boolean; error?: string }>;
}

export interface DesktopUpdateStatus {
  supported: boolean;
  state: "checking" | "available" | "downloading" | "downloaded" | "not-available" | "error" | "unsupported";
  currentVersion: string;
  version?: string;
  releaseNotes?: string;
  percent?: number;
  error?: string;
}

export interface ModelflareStatus {
  mode: "managed" | "external";
  connected: boolean;
  keyTail: string;
  line: ModelflareLine;
  baseUrl: string;
  gateway: string;
}

let cachedVersion = "";
export function appVersion(): string {
  if (!cachedVersion) {
    try {
      cachedVersion = String(JSON.parse(fs.readFileSync(path.join(findAppRoot(), "package.json"), "utf8")).version || "");
    } catch {
      cachedVersion = "";
    }
  }
  return cachedVersion;
}

export interface AppOptions {
  feishuTransport?: (account: { id: string; feishuAppId: string; feishuAppSecret: string; brand: "feishu" | "lark" }) => FeishuTransport;
  messengerTransport?: (id: MessengerId, botId: string, credentials: Record<string, string>) => MessengerTransport;
  weixinFetch?: typeof fetch;
  weixinPollTimeoutMs?: number;
  models?: ModelClient;
  noWeb?: boolean;
  printQrToTerminal?: boolean;
  fileLog?: boolean;
  timeZone?: string;
  deliveryLimits?: Pick<DeliveryOptions, "dailyCap" | "coalesceMs">;
  stewardHomeDir?: string;
  stewardFleetStatePath?: string;
  enableOwnerStewardRouter?: boolean;
  enableStewardPulseTimer?: boolean;
  enableWeChatEnvoyPoller?: boolean;
  stewardPulseIntervalMs?: number;
  opsEnv?: Record<string, string | undefined>;
}

interface BotChannels {
  feishu?: FeishuChannel;
  feishuError?: string;
  weixin?: WeixinChannel;
  weixinLogin?: WeixinLogin;
  messengers?: Partial<Record<MessengerId, MessengerChannel>>;
  messengerErrors?: Partial<Record<MessengerId, string>>;
}

export class App {
  readonly store: Store;
  readonly magpie: MagpieSupervisor | undefined;
  readonly providers: ProviderRegistry;
  readonly modelCatalog: SugentModelCatalog;
  readonly localBudgets: LocalBudgetLedger;
  readonly knowledgeGraph: SugentKnowledgeGraph;
  readonly conciergeBridge: ConciergeChannelBridge;
  readonly hotBundles: HotBundleSlotManager;
  readonly hotReloadBus: HotReloadBus;
  readonly opsBridge: OpsBridgeClient;
  readonly p2Service: SugentP2HostService;
  readonly stewardService: SugentStewardHostService;
  readonly ownerStewardRouter: OwnerChannelStewardRouter;
  readonly models: ModelClient;
  readonly runtime: BotRuntime;
  readonly agent: AgentManager;
  readonly queue = new KeyedQueue();
  readonly channels = new Map<string, BotChannels>();
  readonly outbox: Outbox;
  readonly delivery: Delivery;
  readonly access: AccessControl;
  readonly tasks: TaskService;
  readonly ruleEvents: RuleEvents;
  readonly attention: Attention;
  readonly search: SearchService;
  private webSearch: WebSearchSettings;
  readonly connections: ConnectionService;
  web: WebServer | undefined;
  desktop: DesktopHooks | undefined;
  account!: AccountManager;
  sugentAuth!: SugentAuthManager;
  lastDiagnostics: { model?: import("./diagnostics.js").ModelTestResult; agent?: import("./diagnostics.js").AgentTestResult } = {};
  private readonly opsEnv: Record<string, string | undefined>;
  private readonly executedOpsCommandIds = new Set<string>();
  private readonly notifiedOpsInboxIds = new Set<string>();
  private readonly notifiedPublicConciergeIds = new Set<string>();
  private lastOpsInboxPush?: { sig: string; atMs: number };
  private notices: Array<{ at: number; level: "info" | "warn"; text: string }> = [];
  private offPwsh: (() => void) | undefined;
  private accountTimer: NodeJS.Timeout | undefined;
  private picksTimer: NodeJS.Timeout | undefined;
  private modelPoolSyncTimer: NodeJS.Timeout | undefined;
  private stewardPulseTimer: NodeJS.Timeout | undefined;
  private activeOwnerConvByChannel = new Map<string, { botId: string; conversationId: string }>();
  private modelInfoCache: { at: number; data: Record<string, ModelInfo> } | undefined;
  private modelInfoLoading: Promise<Record<string, ModelInfo>> | undefined;
  private botBudgetCache: { at: number; data: Record<string, { limitUsd: number; remainUsd: number }> } | undefined;
  private lock: DataDirLock | undefined;

  constructor(readonly config: AppConfig, readonly opts: AppOptions = {}) {
    setLangPref(config.ui.lang);
    if (opts.fileLog !== false) initFileLog(path.join(config.dataDir, "logs"));
    registerSecret(config.ui.token);
    registerSecret(config.magpie.externalApiKey);
    log.info(`anymodel bot ${appVersion()} starting`, {
      platform: process.platform,
      arch: process.arch,
      os: os.release(),
      electron: process.versions.electron,
      node: process.versions.node,
      pid: process.pid,
      dataDir: config.dataDir,
      gateway: config.magpie.mode,
      agent: config.agent.mode,
      log: logFilePath(),
    });
    this.store = new Store(path.join(config.dataDir, "anymodel.db"));
    this.providers = new ProviderRegistry(config.dataDir);
    this.modelCatalog = new SugentModelCatalog(config.dataDir);
    this.localBudgets = new LocalBudgetLedger(config.dataDir);
    this.knowledgeGraph = new SugentKnowledgeGraph(resolveUnifiedKnowledgeGraphDir(config.dataDir));
    for (const p of this.providers.listProviders()) {
      if (p.apiKey) registerSecret(p.apiKey);
    }
    this.outbox = new Outbox(this.store);
    this.delivery = new Delivery({ store: this.store, outbox: this.outbox, timeZone: opts.timeZone, ...opts.deliveryLimits });
    this.access = new AccessControl(this.store, { notify: (to, text, id) => this.reach(to, text, id) });
    this.conciergeBridge = new ConciergeChannelBridge({
      dataDir: config.dataDir,
      knowledgeGraph: this.knowledgeGraph,
      resolveActorRole: ({ channel, botId, account, conversationId, senderId }) => {
        const acctKey = account || botId;
        const ownerPeer = this.access.owner(acctKey, channel)?.peerId;
        if (ownerPeer && (ownerPeer === conversationId || ownerPeer === senderId)) {
          return "owner";
        }
        return "external_peer";
      },
      defaultTransport: {
        notifyOwner: async (channel, text) => {
          for (const [key, ch] of this.channels) {
            if (channel === "weixin" && ch.weixin && (await ch.weixin.notifyOwner(text))) return;
            if (channel === "feishu" && ch.feishu) {
              const ownerPeer = this.access.owner(key, "feishu")?.peerId;
              if (ownerPeer && ch.feishu.notify(ownerPeer, text)) return;
            }
          }
          await this.pushToOwner(text);
        },
        sendPeerDirectMessage: async (channel, peerId, text) => {
          if (channel === "wechat_envoy") {
            await this.stewardService.wechatEnvoyClient.sendMessage({ chatId: peerId, text });
            return;
          }
          for (const [, ch] of this.channels) {
            if (channel === "weixin" && ch.weixin && (await ch.weixin.notify(peerId, text))) return;
            if (channel === "feishu" && ch.feishu && ch.feishu.notify(peerId, text)) return;
          }
        },
      },
    });
    const appRootDir = findAppRoot();
    const hostNmDir = path.join(appRootDir, "node_modules");
    this.hotBundles = new HotBundleSlotManager(config.dataDir, {
      ...(!hostNmDir.includes(".asar") && fs.existsSync(hostNmDir) ? { hostNodeModulesDir: hostNmDir } : {}),
    });
    const resolvedUiDir = process.env.SUGENT_UI_DIR && fs.existsSync(process.env.SUGENT_UI_DIR)
      ? path.resolve(process.env.SUGENT_UI_DIR)
      : path.join(appRootDir, "ui");
    this.hotReloadBus = new HotReloadBus({
      dataDir: config.dataDir,
      uiDir: resolvedUiDir,
      enableWatchers: process.env.SUGENT_UI_HOT_RELOAD === "1" && !process.env.VITEST,
    });
    this.p2Service = new SugentP2HostService({
      dataDir: config.dataDir,
      providers: this.providers,
      modelCatalog: this.modelCatalog,
      localBudgets: this.localBudgets,
      knowledgeGraph: this.knowledgeGraph,
      getDefaultModel: () => this.config.llm.defaultModel || this.providers.routing.executor,
      getFetch: () => this.desktop?.fetch ?? fetch,
    });
    this.opsEnv = opts.opsEnv ?? process.env;
    const opsCfg = resolveOpsBridgeConfig(this.opsEnv);
    const edgeToken = String(this.opsEnv.SUGENT_EDGE_TOKEN ?? "").trim();
    const envoyToken = String(this.opsEnv.SUGENT_WECHAT_ENVOY_TOKEN ?? "").trim();
    if (opsCfg.nodeToken) registerSecret(opsCfg.nodeToken);
    if (edgeToken) registerSecret(edgeToken);
    if (envoyToken) registerSecret(envoyToken);
    this.opsBridge = new OpsBridgeClient({
      baseUrl: opsCfg.baseUrl,
      nodeToken: opsCfg.nodeToken,
      nodeId: opsCfg.nodeId,
      opsNodeId: opsCfg.opsNodeId,
      stewardHubNodeId: opsCfg.stewardHubNodeId,
      getFetch: () => this.desktop?.fetch ?? globalThis.fetch,
    });
    const chatRecall = new ChatTranscriptRecallService({
      dataDir: config.dataDir,
      getDb: () => this.store.db,
    });
    this.stewardService = new SugentStewardHostService({
      dataDir: config.dataDir,
      nodeId: opsCfg.nodeId,
      opsBridge: this.opsBridge,
      chatRecall,
      edgeTokens: [edgeToken, opsCfg.nodeToken].filter(Boolean),
      wechatEnvoyEnv: this.opsEnv,
      knowledgeGraph: this.knowledgeGraph,
      localBudgets: this.localBudgets,
      providerRegistry: this.providers,
      modelCatalog: this.modelCatalog,
      conciergeBridge: this.conciergeBridge,
      llmFetch: ((input, init) => (this.desktop?.fetch ?? globalThis.fetch)(input, init)) as typeof fetch,
      recordUsageUsd: (usd) => this.recordLocalBotUsageCost("default", usd),
      getGatewayConfig: () => {
        const resolved = resolveSugentGatewayConfig(this.config, {});
        const pr = this.providers.routing;
        return {
          ...resolved,
          routing: {
            assessor: pr.assessor || resolved.routing.assessor,
            executor: pr.executor || resolved.routing.executor,
            computerUse: pr.computerUse || resolved.routing.computerUse,
            steward: pr.steward || resolved.routing.steward,
          },
        };
      },
      ...(opts.stewardHomeDir ? { homeDir: opts.stewardHomeDir } : {}),
      ...(opts.stewardFleetStatePath ? { fleetStatePath: opts.stewardFleetStatePath } : {}),
      delegateLocalTask: async (input) => {
        const ch = input.channel === "weixin" || input.channel === "feishu" ? input.channel : "web";
        const active = this.activeOwnerConvByChannel.get(ch);
        const botId = active?.botId ?? (this.store.listBots()[0]?.id || "default");
        const fallbackPeer = ch !== "web" ? (this.access.owner(botId, ch)?.peerId || `steward-delegate-${ch}`) : `steward-delegate-${ch}`;
        const conv =
          (active?.conversationId ? this.store.getConversation(active.conversationId) : undefined) ??
          this.store.ensureConversation(botId, ch, fallbackPeer, "Owner", "dm");
        const created = this.tasks.create({
          botId,
          conversationId: conv.id,
          title: input.title,
          brief: input.instruction,
          anytime: true,
        });
        if (!created.task) throw new Error(created.error ?? "FAILED_TO_CREATE_LOCAL_TASK");
        return {
          ok: true,
          taskId: created.task.id,
          status: "queued",
          summary: `已创建本机后台任务「${created.task.title}」（ID: ${created.task.id}）`,
        };
      },
      requestRelaunchQuit: () => this.desktop?.requestRelaunchQuit?.(),
      hotUpdatePort: {
        getStatus: () => ({
          supervised: Boolean(this.desktop?.requestHotReloadCore),
          bus: this.hotReloadBus.getSnapshot(),
          slots: this.hotBundles.getState(),
          ...(this.desktop?.hotUpdateStatus ? { shell: this.desktop.hotUpdateStatus() } : {}),
        }),
        reloadUi: (file) => ({
          ui: this.hotReloadBus.notifyUiChange(file || "ui/main.js"),
          extensions: this.hotReloadBus.reloadExtensions(),
        }),
        reloadCore: (opts) =>
          this.desktop?.requestHotReloadCore
            ? this.desktop.requestHotReloadCore(opts)
            : Promise.resolve({ ok: false, error: "DIRECT_MODE_NO_SUPERVISOR" }),
        stageBundle: (bundleBase64, opts) =>
          this.desktop?.requestStageHotBundle
            ? this.desktop.requestStageHotBundle(bundleBase64, opts)
            : Promise.resolve(this.hotBundles.stageBundleBuffer(Buffer.from(bundleBase64, "base64"), opts)),
        rollbackSlot: () =>
          this.desktop?.requestRollbackHotSlot
            ? this.desktop.requestRollbackHotSlot()
            : Promise.resolve(this.hotBundles.rollbackToPrevious()),
        factoryReset: () => {
          if (this.desktop?.requestFactoryResetHotSlot) return this.desktop.requestFactoryResetHotSlot();
          this.hotBundles.resetToFactoryGolden();
          return Promise.resolve({ ok: true });
        },
      },
      vibeNotifyChannel: async (ev) => {
        for (const [key, ch] of this.channels) {
          if ((ev.channel === "weixin" || ev.channel === "sugent_app") && ch.weixin) {
            await ch.weixin.notifyOwner(ev.text);
            const ownerUser = this.store.getWeixinAccount(key)?.ownerUserId;
            if (ownerUser) {
              for (const m of ev.inlineMedia) {
                void this.outbox.send({ id: `vibe:${ev.pipelineId}:${m.sha256.slice(0, 12)}`, botId: "default", account: key, channel: "weixin", peerId: ownerUser, kind: "file", body: { path: m.absolutePath, name: m.fileName } });
              }
            }
          }
          if ((ev.channel === "feishu" || ev.channel === "sugent_app") && ch.feishu) {
            const ownerPeer = ev.peerId || this.access.owner(key, "feishu")?.peerId;
            if (ownerPeer) ch.feishu.notify(ownerPeer, ev.text);
          }
        }
      },
    });
    if (config.magpie.mode === "managed") {
      this.magpie = new MagpieSupervisor({
        dataDir: config.dataDir,
        binPath: config.magpie.binPath || undefined,
        unlockSubscriptions: () => this.providers.unlockSubscriptions,
      });
    }
    this.models =
      opts.models ??
      new OpenAICompatClient(() =>
        this.magpie
          ? { baseUrl: this.magpie.baseUrl, apiKey: this.magpie.gatewayKey }
          : { baseUrl: config.magpie.externalBaseUrl.replace(/\/+$/, ""), apiKey: config.magpie.externalApiKey },
      );
    const upstream = () =>
      this.magpie
        ? { baseUrl: this.magpie.baseUrl, apiKey: this.magpie.gatewayKey }
        : { baseUrl: config.magpie.externalBaseUrl.replace(/\/+$/, ""), apiKey: config.magpie.externalApiKey };
    this.webSearch = loadWebSearch(this.store);
    this.search = new SearchService({ settings: () => this.webSearch, fetch: () => this.desktop?.fetch });
    this.connections = new ConnectionService({ kv: this.store, fetch: () => this.desktop?.fetch });
    this.agent = new AgentManager({
      store: this.store,
      dataDir: config.dataDir,
      knowledgeGraph: this.knowledgeGraph,
      skillCrystallizeGated: process.env.SUGENT_SKILL_GATE_MODE !== "open",
      maxActiveCrystallizedSkills: 12,
      runtimeDir: config.agent.mode === "dsh" ? locateDshRuntime(findAppRoot()) : undefined,
      upstream,
      enabled: config.agent.mode === "dsh" && !opts.models,
      turnTimeoutMs: config.agent.turnTimeoutMs,
      idleTimeoutMs: config.agent.idleTimeoutMs,
      approvalTtlMs: config.agent.approvalTtlMs,
      contextWindow: async (model) => (await this.infoOf(model))?.context,
      systemProxy: async (url) => this.desktop?.resolveProxy?.(url),
      apiInfo: async (model) => {
        if (!this.magpie) return undefined;
        const info = await this.infoOf(model);
        return info && { endpoints: info.endpoints, reasoning: info.reasoning };
      },
      serverCompaction: {
        listed: async (model) => {
          const info = await this.infoOf(model);
          return info?.endpoints ? info.endpoints.includes(COMPACT_ENDPOINT) : undefined;
        },
        endpoint: (model) => this.compactEndpoint(model),
      },
      complete: (botId, model, system, user) =>
        this.models.streamChat(
          { model: this.routeModel(botId, model), messages: [{ role: "system", content: system }, { role: "user", content: user }], signal: AbortSignal.timeout(120_000) },
          () => {},
        ),
      media: this.magpie
        ? new MediaService({
            baseUrl: () => this.primaryUpstreamBaseUrl(),
            keyFor: (botId) => this.botKey(botId),
            headers: () => (this.isLegacyModelflareActive() ? this.requestHeaders() : {}),
            workspace: (botId) => path.join(config.dataDir, "workspaces", botId),
            defaults: () => ({ image: this.config.media.imageModel, video: this.config.media.videoModel }),
            pricingUrl: () => `${modelflareIssuer()}/api/pricing`,
          })
        : undefined,
      search: this.search,
      connections: this.connections,
      onNotice: (text) => this.notice("warn", text),
    });
    this.attention = new Attention({ store: this.store });
    this.tasks = new TaskService({
      store: this.store,
      host: this.agent.taskHost(),
      delivery: this.delivery,
      approvals: this.agent.approvals,
      onChange: () => this.attention.kick(),
      defaultModel: () => this.config.llm.defaultModel || this.providers.routing.executor,
      route: (botId, model) => this.routeModel(botId, model),
      maxBackground: config.agent.maxBackground,
      complete: (botId, model, system, user) =>
        this.models.streamChat(
          { model: this.routeModel(botId, model), messages: [{ role: "system", content: system }, { role: "user", content: user }], signal: AbortSignal.timeout(120_000) },
          () => {},
        ),
      timeZone: opts.timeZone,
      rates: (model) => this.ratesOf(model),
      botBudget: (botId) => {
        if (!this.store.getBot(botId)?.settings.budget.enabled) return undefined;
        if (this.account?.signedIn) {
          const c = this.botBudgetCache;
          const b = c?.data[botId];
          return c && b ? { ...b, at: c.at } : undefined;
        }
        const local = this.localBudgets.getBotBudgetStatus(botId);
        return local.enabled ? { limitUsd: local.limitUsd, remainUsd: local.remainUsd, at: Date.now() } : undefined;
      },
    });
    this.agent.tasks = this.tasks;
    this.ruleEvents = new RuleEvents(
      createEnvelopedRuleEventSink(this.tasks, {
        privilegedFieldMode: "strip",
        resolveWorkspaceDir: () =>
          path.join(config.dataDir, "workspaces", this.store.listBots()[0]?.id ?? "default"),
      }),
    );
    this.ownerStewardRouter = new OwnerChannelStewardRouter({
      steward: this.stewardService,
      hydrateHistory: ({ channel, peerId, maxMessages }) =>
        this.stewardService.chatRecall.hydrateRecentPeerHistory({ channel, peerId, maxMessages }),
      enabled: () =>
        (opts.enableOwnerStewardRouter ?? (!opts.models && process.env.SUGENT_OWNER_STEWARD_BRIDGE !== "0")) &&
        this.stewardService.hasLiveLlmEndpoint(),
    });
    this.attention.addSource(() => approvalItems(this.store, this.agent.approvals.pendingAll()));
    this.attention.addSource(() => this.tasks.attention());
    this.attention.addSource(() => this.tasks.ruleAttention());
    this.attention.addSource(() => this.delivery.attentionItems().map((d) => deliveryItem(d, this.store.getBot(d.botId)?.name ?? d.botId)));
    this.attention.addSource(() => this.loginAttention());
    this.agent.approvals.listen(() => this.attention.kick());
    this.delivery.onChange(() => this.attention.kick());
    this.runtime = new BotRuntime({
      agent: this.agent,
      store: this.store,
      models: this.models,
      defaultModel: () => this.config.llm.defaultModel || this.providers.routing.executor,
      contextMessages: config.llm.contextMessages,
      contextChars: config.llm.contextChars,
      route: (botId, model) => this.routeModel(botId, model),
      access: this.access,
      conciergeIntercept: (ev) => this.conciergeBridge.interceptRuntimeReply(ev),
      ownerStewardIntercept: async (ev, convId, text, onBeforeReply) => {
        const acctKey = ev.account || ev.botId;
        const ownerPeer = this.access.owner(acctKey, ev.channel)?.peerId;
        const isGroup = ev.conversation.kind === "group";
        const isOwnerPeer = Boolean(!isGroup && ownerPeer && ownerPeer === ev.conversation.id);
        const inbound = {
          botId: ev.botId,
          account: acctKey,
          channel: ev.channel,
          peerId: ev.conversation.id,
          isGroup,
          isOwnerPeer,
          text,
        };
        if (!this.ownerStewardRouter.canIntercept(inbound)) {
          return { handled: false };
        }
        this.activeOwnerConvByChannel.set(ev.channel, { botId: ev.botId, conversationId: convId });
        await onBeforeReply?.();
        const res = await this.ownerStewardRouter.tryHandleInbound(inbound);
        return res.handled ? { handled: true, reply: res.reply } : { handled: false };
      },
      recoverKey: () => (this.account?.signedIn ? this.account.repairKeys(15_000) : Promise.resolve(false)),
    });
  }

  private isLegacyModelflareActive(): boolean {
    return Boolean(this.magpie?.modelflareInfo().connected);
  }

  private primaryUpstreamBaseUrl(): string {
    const def = this.providers.getDefaultProvider();
    if (def?.baseUrl) return def.baseUrl;
    return modelflareBaseUrl(this.config.modelflare.line);
  }

  private loginAttention(): AttentionItem[] {
    const out: AttentionItem[] = [];
    for (const [key, ch] of this.channels) {
      const st = ch.weixin?.status;
      if (st?.state !== "expired") continue;
      const subject = tr("app.weixinExpiredSubject");
      out.push({ id: `login:${key}:weixin`, kind: "login", botId: defaultBotFor(this.store, key, "weixin"), botName: this.store.getChannelAccount(key, "weixin")?.label ?? key, subject, status: "", head: subject, line: "", since: st.since, severity: "err", actions: ["relogin"], channel: "weixin" });
    }
    return out;
  }

  private reach(to: { botId: string; channel: string; peerId: string }, text: string, id: string): boolean {
    const ch = this.channels.get(to.botId);
    try {
      if (to.channel === "weixin") return !!ch?.weixin?.tell(to.peerId, text, id);
      if (to.channel === "feishu") return !!ch?.feishu?.notify(to.peerId, text, id);
      if (isMessenger(to.channel)) return !!ch?.messengers?.[to.channel]?.notify(to.peerId, text, id);
    } catch (e) {
      log.warn("notify failed", { bot: to.botId, channel: to.channel, message: (e as Error).message });
    }
    return false;
  }

  markDesktopBootHealthy(pid: number, version: string): void {
    void this.stewardService.markBootHealthy(pid, version).catch((e) => log.warn("boot healthy mark failed", { message: (e as Error).message }));
  }

  isStewardPulseTimerActive(): boolean {
    return Boolean(this.stewardPulseTimer);
  }

  weixinGuard(): WeixinSingleHolderVerdict {
    return evaluateWeixinSingleHolderGuard(this.opsEnv, this.opsBridge.nodeId);
  }

  private async pullAndExecuteOpsCommands(): Promise<void> {
    const pulled = await this.opsBridge.pullCommands();
    if (!pulled.ok || !pulled.commands?.length) return;
    for (const cmd of pulled.commands) {
      if (cmd.targetNodeId && cmd.targetNodeId !== this.opsBridge.nodeId) continue;
      if (this.executedOpsCommandIds.has(cmd.id)) {
        await this.opsBridge.ackCommand(cmd.id, { status: "accepted", summary: "Already queued locally" });
        continue;
      }
      try {
        const botId = this.store.listBots()[0]?.id || "default";
        const conv = this.store.ensureConversation(botId, "web", `ops-cmd-${this.opsBridge.nodeId}`, "Ops Bridge", "dm");
        const title = cmd.title || `[Ops] ${cmd.action}`;
        const brief = cmd.summary ? `${cmd.action}: ${cmd.summary}` : cmd.action;
        const created = this.tasks.create({
          botId,
          conversationId: conv.id,
          title,
          brief,
          anytime: true,
        });
        if (created.task) {
          if (this.executedOpsCommandIds.size >= 500) {
            const oldest = this.executedOpsCommandIds.values().next().value;
            if (oldest) this.executedOpsCommandIds.delete(oldest);
          }
          this.executedOpsCommandIds.add(cmd.id);
          await this.opsBridge.ackCommand(cmd.id, {
            status: "accepted",
            summary: `Queued local task ${created.task.id}`,
          });
        } else {
          await this.opsBridge.ackCommand(cmd.id, {
            status: "failed",
            summary: created.error ?? "TASK_CREATE_REJECTED",
          });
        }
      } catch (e) {
        await this.opsBridge.ackCommand(cmd.id, {
          status: "failed",
          summary: (e as Error).message.slice(0, 200),
        });
      }
    }
  }

  async syncOpsBridgeTick(nowMs = Date.now()): Promise<void> {
    if (!this.opsBridge.isConfigured()) return;
    const localPulses = this.stewardService.collectLocalOpsProjectPulses();
    if (this.opsBridge.isStewardHub()) {
      const pending = await this.opsBridge.stewardPending();
      if (pending.ok && pending.snapshot) {
        this.stewardService.setRemoteOpsSnapshot(pending.snapshot);
        const freshInbox = (pending.snapshot.pendingInbox ?? []).filter(
          (it) => it?.id && !this.notifiedOpsInboxIds.has(it.id),
        );
        if (freshInbox.length > 0 && !this.stewardService.getWorkbench("owner_private").quietHoursActive) {
          const lines = [
            `【待签批派单提醒 · ${freshInbox.length} 项】`,
            ...freshInbox.slice(0, 4).map(
              (it) =>
                `- ${it.id}「${it.title}」(${it.targetNodeId || "local-mac"})：${it.requiresDashboardConfirm ? "需 /ops 看板二次确认" : `回复 /ok ${it.id} 放行`}`,
            ),
          ];
          const text = lines.join("\n");
          const duplicateWithin1m =
            this.lastOpsInboxPush &&
            this.lastOpsInboxPush.sig === text &&
            nowMs - this.lastOpsInboxPush.atMs < 60_000;
          if (!duplicateWithin1m) {
            this.lastOpsInboxPush = { sig: text, atMs: nowMs };
            for (const it of freshInbox) this.notifiedOpsInboxIds.add(it.id);
            await this.pushToOwner(text).catch(() => false);
          }
        }
        const freshVisitors = (pending.snapshot.publicConciergeQueue ?? []).filter(
          (v) => v?.sessionId && !this.notifiedPublicConciergeIds.has(v.sessionId),
        );
        if (freshVisitors.length > 0 && !this.stewardService.getWorkbench("owner_private").quietHoursActive) {
          const vLines = [
            `【官网数字分身来客 · ${freshVisitors.length} 位】`,
            ...freshVisitors.slice(0, 4).map(
              (v) =>
                `- ${v.sessionId}「${v.actorLabel || v.actorName || "匿名访客"}」：${v.intentSummary || v.summary || "来访咨询"}\n  快捷代回：/pub ${v.sessionId} <您的回复>（忽略回 /pub decline ${v.sessionId}）`,
            ),
          ];
          for (const v of freshVisitors) this.notifiedPublicConciergeIds.add(v.sessionId);
          await this.pushToOwner(vLines.join("\n")).catch(() => false);
        }
      }
      const pendingCommitmentUpdates = this.stewardService.peekPendingOpsCommitmentUpdates();
      if (pendingCommitmentUpdates.length > 0) {
        const syncRes = await this.opsBridge.stewardSync({ commitmentUpdates: pendingCommitmentUpdates });
        if (syncRes.ok) {
          this.stewardService.ackOpsCommitmentUpdates(pendingCommitmentUpdates.map((u) => u.id));
        }
      }
      if (localPulses.length > 0) {
        await this.opsBridge.pushPulse(localPulses);
      }
    } else {
      const fleet = await this.opsBridge.fetchFleetSnapshot();
      if (fleet.ok && fleet.snapshot) {
        this.stewardService.setRemoteOpsSnapshot(fleet.snapshot);
      }
      await this.opsBridge.pushPulse(localPulses);
    }
    await this.pullAndExecuteOpsCommands();
  }

  async runStewardPulseTick(input: {
    nowMs?: number;
    forceMorningDrain?: boolean;
    drainBoundary?: boolean;
    forceGardener?: boolean;
    gardenerIntervalMs?: number;
  } = {}) {
    await this.syncOpsBridgeTick().catch((e) => log.warn("ops bridge tick failed", { message: (e as Error).message }));
    const res = this.stewardService.runScheduledPulse(input);
    if (res.morningDrain && res.morningDrain.emitNow.length > 0) {
      const lines = [
        `【早间对齐简报 · ${res.dateKey}】`,
        ...res.morningDrain.emitNow.slice(0, 5).map((c, idx) => `${idx + 1}. ${c.title} — ${c.threeLineBody[0]}`),
      ];
      await this.pushToOwner(lines.join("\n")).catch(() => false);
    }
    if (res.unsnoozedWakeups && res.unsnoozedWakeups.length > 0 && !this.stewardService.getWorkbench("owner_private").quietHoursActive) {
      const morningRefs = new Set((res.morningDrain?.emitNow ?? []).map((c) => c.targetRefId).filter(Boolean));
      const uncovered = res.unsnoozedWakeups.filter((w) => !morningRefs.has(w.id));
      if (uncovered.length > 0) {
        const wLines = [
          `【今日到期亲办唤醒 · ${uncovered.length} 项】`,
          ...uncovered.slice(0, 5).map((w) => `- ${w.summary}（${w.counterpartyOrRef}）\n  办完可回：/done ${w.id.split(":").pop()}`),
        ];
        await this.pushToOwner(wLines.join("\n")).catch(() => false);
      }
    }
    if (res.boundaryDrain && res.boundaryDrain.emitNow.length > 0) {
      const lines = [
        "【心流间隙待办汇总】",
        ...res.boundaryDrain.emitNow.slice(0, 5).map((c, idx) => `${idx + 1}. ${c.title} — ${c.threeLineBody[0]}`),
      ];
      await this.pushToOwner(lines.join("\n")).catch(() => false);
    }
    if (!res.morningDrain?.emitNow.length && res.scan.emitNow.length > 0) {
      const urgent = res.scan.emitNow.filter((c) => c.urgency === "urgent");
      if (urgent.length > 0) {
        const lines = [
          "【幕僚高优提醒】",
          ...urgent.slice(0, 3).map((c) => `- ${c.title}：${c.threeLineBody[0]}`),
        ];
        await this.pushToOwner(lines.join("\n"), { urgency: "urgent", title: "幕僚高优提醒" }).catch(() => false);
      }
    }
    return res;
  }

  async prewarmAgent(): Promise<void> {
    if (process.env.AMB_AGENT_PREWARM === "0" || this.opts.noWeb || !this.agent.available) return;
    const bot = this.store.listBots()[0];
    if (!bot) return;
    try {
      const model = bot.defaultModel || this.config.llm.defaultModel || this.providers.routing.executor || (await this.runtime.listModels(true).catch(() => [] as string[]))[0] || "";
      if (model) this.agent.prewarm(bot.id, this.routeModel(bot.id, model));
    } catch (e) {
      log.warn("agent prewarm skipped", { message: (e as Error).message });
    }
  }

  private compactEndpoint(model: string): CompactEndpoint | undefined {
    if (!this.magpie) return undefined;
    const i = model.indexOf("/");
    const id = i > 0 ? model.slice(0, i) : "";
    const up = id ? this.magpie.upstreamEndpoint(id) : undefined;
    if (!up || up.id !== id) return undefined;
    if (!this.magpie.nativeCompaction(up.id)) {
      void this.magpie.ensureNativeCompaction(up.id).catch((e) => log.warn("turning on native compaction failed", { provider: up.id, message: (e as Error).message }));
      return undefined;
    }
    const isLegacy = id === MODELFLARE_PROVIDER || id === "modelflare-legacy" || id.startsWith("mfb-");
    return { baseUrl: up.baseUrl, apiKey: up.apiKey, model: model.slice(i + 1), headers: isLegacy ? this.requestHeaders() : {} };
  }

  requestHeaders(): Record<string, string> {
    return skillHeader(appVersion());
  }

  routeModel(botId: string, model: string): string {
    const trimmed = model.trim();
    if (!this.magpie || !trimmed) return trimmed;
    const own = botProviderId(botId);
    if (this.magpie.hasProvider(own)) return routeModel(trimmed, own);

    const slash = trimmed.indexOf("/");
    if (slash > 0) {
      const prefix = trimmed.slice(0, slash);
      if (this.providers.getProvider(prefix) || this.magpie.hasProvider(prefix)) {
        return trimmed;
      }
    }

    const defaultProvId = this.providers.getDefaultProviderId();
    if (defaultProvId && (this.magpie.hasProvider(defaultProvId) || this.providers.getProvider(defaultProvId))) {
      return routeModel(trimmed, defaultProvId);
    }

    return routeModel(trimmed, this.magpie.modelflareProviderId ?? MODELFLARE_PROVIDER);
  }

  private async syncModelPicks(): Promise<void> {
    const magpie = this.magpie;
    if (!magpie || magpie.state !== "running") return;
    const baseUrl = modelflareBaseUrl(this.config.modelflare.line);
    const ids = [magpie.modelflareProviderId, ...magpie.botProviderIds()].filter((id): id is string => !!id);
    for (const id of ids) {
      const key = magpie.providerKey(id);
      if (!key) continue;
      try {
        await magpie.ensureModelflareApis(id);
        if (serverCompactionEnabled()) await magpie.ensureNativeCompaction(id).catch((e) => log.warn("turning on native compaction failed", { provider: id, message: (e as Error).message }));
        const r = await verifyModelflareKey(baseUrl, key, { line: this.config.modelflare.line });
        if (r.ok) await magpie.setModelPicks(id, r.chatModels);
      } catch (e) {
        log.warn("sync model picks failed", { provider: id, message: (e as Error).message });
      }
    }
  }

  private async syncDecoupledProvidersToMagpie(): Promise<void> {
    const magpie = this.magpie;
    if (!magpie || magpie.state !== "running") return;
    if (this.providers.listProviders().length === 0) {
      const mfId = magpie.modelflareProviderId;
      const mfInfo = magpie.modelflareInfo();
      const mfKey = mfId ? magpie.providerKey(mfId) : "";
      if (mfInfo.connected && mfKey && mfInfo.baseUrl) {
        this.providers.adoptLegacyProviderIfEmpty({
          baseUrl: mfInfo.baseUrl,
          apiKey: mfKey,
        });
      }
    }
    for (const p of this.providers.listProviders()) {
      if (!p.enabled || p.preset === "modelflare-legacy") continue;
      try {
        await magpie.upsertGenericProvider({
          id: p.id,
          name: p.name,
          baseUrl: p.baseUrl,
          apiKey: p.apiKey,
          apiBases: deriveMagpieApiBases(p),
          picks: p.models,
        });
      } catch (e) {
        log.warn("sync decoupled provider to magpie failed", { provider: p.id, message: (e as Error).message });
      }
    }
  }

  async syncProviderModels(providerId?: string, force = false): Promise<ProviderSyncResult[]> {
    return this.stewardService.syncModelPool({
      ...(providerId ? { providerId } : {}),
      force,
    });
  }

  async upsertDecoupledProvider(
    input: UpsertProviderInput,
  ): Promise<{ provider: PublicProviderItem; models: string[] }> {
    const normalizedPreset = normalizeProviderPresetId(input.preset);
    const saved = this.providers.upsertProvider({
      ...input,
      preset: normalizedPreset,
    });
    if (saved.apiKey) registerSecret(saved.apiKey);

    if (saved.baseUrl && saved.enabled) {
      await this.syncProviderModels(saved.id, true).catch(() => []);
    }
    const latestProvider = this.providers.getProvider(saved.id) ?? saved;
    const discoveredModels = latestProvider.models ?? [];

    if (this.magpie && this.magpie.state === "running" && saved.enabled && saved.preset !== "modelflare-legacy") {
      await this.magpie.upsertGenericProvider({
        id: saved.id,
        name: saved.name,
        baseUrl: saved.baseUrl,
        apiKey: saved.apiKey,
        apiBases: deriveMagpieApiBases(saved),
        picks: discoveredModels.length > 0 ? discoveredModels : undefined,
      });
    }

    this.modelInfoCache = undefined;
    const gatewayModels = await this.runtime.listModels(true).catch(() => [] as string[]);
    const models = gatewayModels.length > 0 ? gatewayModels : discoveredModels.map((m) => `${saved.id}/${m}`);
    const publicItem = this.providers.publicView().providers.find((x) => x.id === saved.id)!;
    void this.prewarmAgent();
    return { provider: publicItem, models };
  }

  async removeDecoupledProvider(id: string): Promise<boolean> {
    const ok = this.providers.removeProvider(id);
    if (ok && this.magpie && this.magpie.state === "running") {
      await this.magpie.removeGenericProvider(id).catch((e) => log.warn("remove generic provider failed", { provider: id, message: (e as Error).message }));
    }
    this.modelInfoCache = undefined;
    return ok;
  }

  async setDefaultDecoupledProvider(id: string) {
    this.providers.setDefaultProvider(id);
    return this.providers.publicView();
  }

  async updateProviderRouting(patch: {
    unlockSubscriptions?: boolean;
    defaultProviderId?: string;
    defaultModel?: string;
    assessor?: string;
    executor?: string;
    computerUse?: string;
    steward?: string;
    routing?: Partial<Record<SugentRoleKey, string>>;
  }) {
    if (patch.defaultProviderId && this.providers.getProvider(patch.defaultProviderId)) {
      this.providers.setDefaultProvider(patch.defaultProviderId);
    }
    if (typeof patch.unlockSubscriptions === "boolean" && patch.unlockSubscriptions !== this.providers.unlockSubscriptions) {
      this.providers.setUnlockSubscriptions(patch.unlockSubscriptions);
      if (this.magpie) {
        await this.magpie.applySubscriptionDiscoverySetting().catch((e) => log.warn("apply subscription discovery failed", { message: (e as Error).message }));
        await this.syncDecoupledProvidersToMagpie();
      }
    }
    const mergedRouting: Partial<Record<SugentRoleKey, string>> = {};
    for (const k of ["assessor", "executor", "computerUse", "steward"] as const) {
      if (patch.routing && patch.routing[k] !== undefined) mergedRouting[k] = String(patch.routing[k] ?? "");
      else if (patch[k] !== undefined) mergedRouting[k] = String(patch[k] ?? "");
    }
    if (Object.keys(mergedRouting).length > 0) {
      this.providers.setRoleRouting(mergedRouting);
    }
    if (patch.defaultModel !== undefined) {
      this.setDefaultModel(String(patch.defaultModel));
    } else if (mergedRouting.executor && !this.config.llm.defaultModel) {
      this.setDefaultModel(mergedRouting.executor);
    }
    const models = await this.runtime.listModels(true).catch(() => [] as string[]);
    return { ...this.providers.publicView(), models };
  }

  private botKey(botId: string): string {
    const def = this.providers.getDefaultProvider();
    if (def?.apiKey) return def.apiKey;
    if (!this.magpie) return "";
    return this.magpie.providerKey(botProviderId(botId)) || this.magpie.providerKey(this.magpie.modelflareProviderId ?? MODELFLARE_PROVIDER);
  }

  ensureSugentAuth(): SugentAuthManager {
    this.sugentAuth ??= new SugentAuthManager({
      dataDir: this.config.dataDir,
      secretBox: this.desktop?.secretBox,
      fetchImpl: this.desktop?.fetch,
      onProvisioned: async (evt) => {
        const authCfg = this.sugentAuth.getConfig();
        if (authCfg.provisioningMode === "token_passthrough" || authCfg.provisioningMode === "key_exchange") {
          const tokenOrKey = evt.provisionedKey ?? evt.accessToken;
          if (authCfg.mode === "google" && authCfg.provisioningMode === "token_passthrough") {
            if (tokenOrKey) {
              await this.upsertDecoupledProvider({
                id: "google-oauth-gemini",
                name: evt.name ? `Google Gemini (${evt.name})` : "Google Gemini (OAuth)",
                preset: "gemini",
                baseUrl: LLM_PROVIDER_PRESETS.gemini.defaultBaseUrl,
                apiKey: tokenOrKey,
                setDefault: !this.providers.getDefaultProvider(),
              });
            }
            return;
          }
          const def = this.providers.getDefaultProvider();
          const targetBase = def?.baseUrl || (authCfg.issuer ? `${authCfg.issuer.replace(/\/+$/, "")}/v1` : "");
          if (tokenOrKey && targetBase) {
            await this.upsertDecoupledProvider({
              id: def?.id ?? "enterprise-oidc",
              name: def?.name ?? (evt.name ? `Enterprise (${evt.name})` : "Enterprise OIDC Gateway"),
              preset: def?.preset ?? "cowork",
              baseUrl: targetBase,
              apiKey: tokenOrKey,
              setDefault: true,
            });
          }
        }
      },
    });
    return this.sugentAuth;
  }

  configureSugentAuth(patch: SugentAuthConfigPatch): SugentAuthConfig {
    if (typeof patch.clientSecret === "string" && patch.clientSecret.trim()) {
      registerSecret(patch.clientSecret.trim());
    }
    return this.ensureSugentAuth().configure(patch);
  }

  applySugentAuthBrokerPreset(opts?: {
    brokerOrigin?: string;
    idpHint?: "wechat" | "apple" | "google" | "feishu" | "dingtalk";
  }): SugentAuthConfig {
    const preset = buildBrokerDesktopAuthConfig({
      ...(opts?.brokerOrigin ? { issuerUrl: opts.brokerOrigin } : {}),
      ...(opts?.idpHint ? { idpHint: opts.idpHint } : {}),
    });
    const next = this.configureSugentAuth({
      mode: preset.mode,
      issuer: preset.issuerUrl,
      clientId: preset.clientId,
      clearClientSecret: true,
      scopes: [...preset.scopes],
    });
    return {
      ...next,
      hasClientSecret: Boolean(next.hasClientSecret),
    };
  }

  activeBrokerClaims(): SugentBrokerClaims | null {
    try {
      const auth = this.ensureSugentAuth();
      if (auth.getConfig().mode === "none") return null;
      const rec = auth.vault.load();
      const jwt = rec?.idToken || rec?.accessToken;
      return jwt ? decodeJwtPayloadUnsafe(jwt) : null;
    } catch {
      return null;
    }
  }

  activeBrokerToken(): string {
    try {
      return this.ensureSugentAuth().vault.load()?.accessToken ?? "";
    } catch {
      return "";
    }
  }

  async probeGeminiWeb2ApiProvider(input?: {
    baseUrl?: string;
    apiKey?: string;
    providerId?: string;
  }): Promise<GeminiWeb2ApiProbeResult & { syncedProviderId?: string }> {
    const existing = input?.providerId ? this.providers.getProvider(input.providerId) : undefined;
    const probe = await probeGeminiWeb2Api({
      baseUrl: input?.baseUrl ?? existing?.baseUrl,
      apiKey: input?.apiKey ?? existing?.apiKey,
      fetchImpl: this.desktop?.fetch ?? fetch,
    });
    if (existing && probe.ok && probe.models.length > 0) {
      await this.upsertDecoupledProvider({
        id: existing.id,
        models: probe.models,
      });
      return { ...probe, syncedProviderId: existing.id };
    }
    return probe;
  }

  ensureAccount(): AccountManager {
    this.account ??= this.createAccount();
    return this.account;
  }

  private createAccount(): AccountManager {
    const account = new AccountManager({
      issuer: modelflareIssuer(),
      vault: AccountVault.at(this.config.dataDir, this.desktop?.secretBox),
      store: this.store,
      alerts: () => ({ lowBalanceUsd: this.config.modelflare.lowBalanceUsd, push: this.config.modelflare.lowBalancePush }),
      hooks: {
        connectKey: async (key) => {
          const r = await this.connectModelflare(key, this.config.modelflare.line);
          if (!r.ok) throw new Error(r.message);
        },
        disconnect: () => this.disconnectModelflare(),
        setBotKey: async (botId, key) => {
          if (!this.magpie) throw new Error(t("app.external_mode"));
          const baseUrl = modelflareBaseUrl(this.config.modelflare.line);
          const r = await verifyModelflareKey(baseUrl, key, { line: this.config.modelflare.line });
          if (!r.ok) throw new Error(r.message);
          await this.magpie.setBotProvider(botId, key, baseUrl, this.allowedModelflareUrls(), this.requestHeaders(), r.chatModels);
        },
        removeBotKey: async (botId) => {
          await this.magpie?.removeBotProvider(botId);
        },
        keyBalance: async () => {
          const key = this.magpie?.providerKey(this.magpie.modelflareProviderId ?? MODELFLARE_PROVIDER);
          return key ? fetchKeyBalance(modelflareBaseUrl(this.config.modelflare.line), key) : undefined;
        },
        sharedKeyTail: () => this.magpie?.modelflareInfo().keyTail ?? "",
        sharedKeyRejected: async () => {
          if (!this.magpie) return false;
          const key = this.magpie.providerKey(this.magpie.modelflareProviderId ?? MODELFLARE_PROVIDER);
          if (!key) return true;
          const line = this.config.modelflare.line;
          const r = await verifyModelflareKey(modelflareBaseUrl(line), key, { line });
          return !r.ok && r.code === "invalid_key";
        },
        alert: (text, push) => {
          this.notice("warn", text);
          if (push) void this.pushToOwner(text);
        },
      },
    });
    account.botsSource = () => this.store.listBots().map((b) => ({ id: b.id, name: b.name, budget: b.settings.budget }));
    account.init();
    return account;
  }

  async pushToOwner(
    text: string,
    opts?: { urgency?: "normal" | "high" | "urgent"; title?: string },
  ): Promise<boolean> {
    const urgency = opts?.urgency ?? "normal";
    const firstLine = text.split("\n")[0]?.replace(/^【|】$/g, "").trim() || "幕僚提醒";
    const title = opts?.title?.trim() || firstLine.slice(0, 48);
    let fallbackBody = text;

    for (const [key, ch] of this.channels) {
      try {
        if (ch?.weixin) {
          if (typeof ch.weixin.ownerQuotaSnapshot === "function") {
            const snap = ch.weixin.ownerQuotaSnapshot();
            if (snap.ownerUserId) {
              const guard = this.stewardService.weixinQuotaGuard;
              // If quota recovered above lowWatermark and there are buffered items, flush digest first
              if (snap.connected && snap.remaining > guard.lowWatermark + 1 && guard.getBufferedCount(snap.ownerUserId) > 0) {
                const flushed = guard.flushCoalescedDigest(snap.ownerUserId, snap.remaining);
                if (flushed.flushedCount > 0 && flushed.digestText) {
                  await ch.weixin.notifyOwner(flushed.digestText).catch(() => false);
                }
              }
              const refreshedSnap = ch.weixin.ownerQuotaSnapshot();
              const decision = guard.routeProactivePush({
                peerId: snap.ownerUserId,
                title,
                body: text,
                urgency,
                remainingQuota: refreshedSnap.remaining,
                channelState: refreshedSnap.connected ? "connected" : "expired",
              });
              if (decision.action === "buffered_low_quota") {
                return true;
              }
              if (decision.action === "send_weixin_now") {
                const outText =
                  refreshedSnap.remaining <= guard.lowWatermark ? decision.formattedText : text;
                if (await ch.weixin.notifyOwner(outText)) return true;
              } else if (decision.action === "fallback_channel") {
                fallbackBody = decision.alertText;
              }
            }
          } else if (await ch.weixin.notifyOwner(text)) {
            return true;
          }
        }
        const chat = ch?.feishu
          ? (this.access.owner(key, "feishu")?.peerId ??
              this.store.listAccountConversations(key, "feishu").find((c) => c.kind === "dm")?.peerId)
          : undefined;
        if (chat && ch?.feishu?.notify(chat, fallbackBody)) return true;
        for (const id of MESSENGERS) {
          const owner = this.access.owner(key, id)?.peerId;
          if (owner && ch?.messengers?.[id]?.notify(owner, fallbackBody)) return true;
        }
      } catch (e) {
        log.warn("push to owner failed", { account: key, message: (e as Error).message.slice(0, 200) });
      }
    }
    return false;
  }

  async setBotBudget(botId: string, budget: BotSettings["budget"]): Promise<Bot> {
    const bot = this.store.getBot(botId);
    if (!bot) throw new Error(t("app.bot_not_found"));
    const useLocalLedger = !this.account?.signedIn && (this.providers.hasActiveConnection() || !this.magpie);
    if (useLocalLedger) {
      this.localBudgets.setBotBudget(bot.id, { enabled: budget.enabled, limitUsd: budget.limitUsd });
      const out = this.store.updateBot(botId, { settings: { ...bot.settings, budget } })!;
      this.tasks.budgetsChanged();
      return out;
    }
    await this.account.setBotBudget(bot.id, bot.name, budget);
    const out = this.store.updateBot(botId, { settings: { ...bot.settings, budget } })!;
    void this.refreshBotBudgets();
    return out;
  }

  recordLocalBotUsageCost(botId: string, costUsd: number, nowMs = Date.now()) {
    const status = this.localBudgets.recordUsageCost(botId, costUsd, nowMs);
    this.tasks.budgetsChanged();
    return status;
  }

  async refreshBotBudgets(): Promise<void> {
    if (!this.account?.signedIn || !this.store.listBots().some((b) => b.settings.budget.enabled)) {
      if (this.botBudgetCache) {
        this.botBudgetCache = undefined;
        this.tasks.budgetsChanged();
      }
      return;
    }
    try {
      const keys = await this.account.botBudgets();
      const data: Record<string, { limitUsd: number; remainUsd: number }> = {};
      for (const [botId, k] of Object.entries(keys)) {
        if (k.limit_usd === null || !(k.limit_usd > 0)) continue;
        data[botId] = { limitUsd: k.limit_usd, remainUsd: k.status === "exhausted" ? 0 : Math.max(0, Number(k.remain_usd ?? k.limit_usd - k.used_usd)) };
      }
      this.botBudgetCache = { at: Date.now(), data };
      this.tasks.budgetsChanged();
    } catch (e) {
      log.warn("reading bot budgets failed", { message: (e as Error).message.slice(0, 200) });
    }
  }

  private ratesOf(model: string): Rates | undefined {
    const c = this.modelInfoCache;
    if (this.isLegacyModelflareActive() && (!c || Date.now() - c.at > 3600_000)) {
      void this.modelInfo().catch(() => undefined);
    }
    if (c) {
      const bare = bareModel(model);
      const hit = (c.data[bare] ?? c.data[bare.split("/").pop() ?? bare])?.rates;
      if (hit) return hit;
    }
    const localRates = this.modelCatalog.getModelInfo(model).rates;
    return localRates ? { input: localRates.input, output: localRates.output, cacheRead: localRates.cacheRead, cacheWrite: localRates.cacheWrite } : undefined;
  }

  async deleteBot(botId: string): Promise<void> {
    const bot = this.store.getBot(botId);
    this.tasks.dropBot(botId);
    await this.agent.stopBot(botId);
    if (bot?.settings.budget.enabled) {
      this.localBudgets.setBotBudget(botId, { enabled: false, limitUsd: 0 });
      if (this.account?.signedIn) {
        await this.account.setBotBudget(botId, bot.name, { ...bot.settings.budget, enabled: false }).catch((e) => log.warn("remove bot key failed", { message: (e as Error).message }));
      }
    }
    this.store.deleteBot(botId);
  }

  async modelInfo(force = false): Promise<Record<string, ModelInfo>> {
    if (!this.isLegacyModelflareActive()) {
      const out: Record<string, ModelInfo> = {};
      const models = await this.runtime.listModels(false).catch(() => [] as string[]);
      for (const m of models) {
        const bare = bareModel(m);
        out[bare] = this.modelCatalog.getModelInfo(m);
      }
      for (const p of this.providers.listProviders()) {
        if (!p.enabled || !p.models) continue;
        for (const m of p.models) {
          const bare = bareModel(m);
          out[bare] ??= this.modelCatalog.getModelInfo(m);
        }
      }
      return out;
    }
    if (!force && this.modelInfoCache && Date.now() - this.modelInfoCache.at < 3600_000) return this.modelInfoCache.data;
    this.modelInfoLoading ??= (async () => {
      const key = this.magpie?.providerKey(this.magpie.modelflareProviderId ?? MODELFLARE_PROVIDER) ?? "";
      const data = await loadModelInfo({
        baseUrl: modelflareBaseUrl(this.config.modelflare.line),
        apiKey: key,
        headers: this.requestHeaders(),
        pricingUrl: `${modelflareIssuer()}/api/pricing`,
      });
      this.modelInfoCache = { at: Date.now(), data };
      return data;
    })().finally(() => (this.modelInfoLoading = undefined));
    return this.modelInfoLoading;
  }

  private async infoOf(model: string): Promise<ModelInfo | undefined> {
    if (this.isLegacyModelflareActive()) {
      const info = await this.modelInfo();
      const bare = bareModel(model);
      const remoteHit = info[bare] ?? info[bare.split("/").pop() ?? bare];
      if (remoteHit) return remoteHit;
    }
    return this.modelCatalog.getModelInfo(model);
  }

  notice(level: "info" | "warn", text: string): void {
    this.notices.push({ at: Date.now(), level, text });
    if (this.notices.length > 50) this.notices.shift();
    log[level](text);
  }

  get recentNotices() {
    return this.notices.slice().reverse();
  }

  async start(): Promise<void> {
    this.lock ??= lockDataDir(this.config.dataDir);
    if (this.magpie) {
      try {
        await this.magpie.start();
        await this.syncDecoupledProvidersToMagpie();
      } catch (e) {
        this.notice("warn", t("app.magpie_failed", { message: (e as Error).message }));
      }
    }
    this.agent.start();
    this.ensureSugentAuth();
    this.ensureAccount();
    this.seedDefaultBot();
    const interrupted = takeInterrupted(this.store);
    this.outbox.start();
    this.delivery.start();
    for (const bot of this.store.listBots()) this.adoptBotChannels(bot.id);
    for (const key of new Set(this.store.listChannelAccounts().map((a) => a.key))) await this.startBot(key);
    if (interrupted.length) void this.tellInterrupted(interrupted);
    if (this.agent.available) {
      this.tasks.start();
      if (this.isLegacyModelflareActive()) void this.modelInfo().catch(() => undefined);
    }
    if (!this.opts.noWeb) this.web = await startWebServer(this);
    if (this.magpie) {
      void this.syncModelPicks();
      this.picksTimer = setInterval(() => void this.syncModelPicks(), 3600_000);
      this.picksTimer.unref();
    }
    void this.syncProviderModels(undefined, false).catch(() => {});
    this.modelPoolSyncTimer = setInterval(() => {
      void this.syncProviderModels(undefined, false).catch(() => {});
    }, 10 * 60_000);
    this.modelPoolSyncTimer.unref();
    const enableEnvoyPoller =
      this.opts.enableWeChatEnvoyPoller ?? (!process.env.VITEST && !this.opts.noWeb);
    if (enableEnvoyPoller && this.stewardService.wechatEnvoyClient.isConfigured()) {
      this.stewardService.wechatEnvoyPoller.start();
    }
    const enablePulse = this.opts.enableStewardPulseTimer ?? (!process.env.VITEST && !this.opts.noWeb);
    if (enablePulse) {
      if (this.opsBridge.isConfigured()) {
        setTimeout(() => {
          void this.syncOpsBridgeTick().catch((e) => log.warn("initial ops bridge sync failed", { message: (e as Error).message }));
        }, 2000).unref();
      }
      const pulseMs = Math.max(5_000, this.opts.stewardPulseIntervalMs ?? 15 * 60_000);
      this.stewardPulseTimer = setInterval(() => {
        void this.runStewardPulseTick().catch((e) => log.warn("steward pulse tick failed", { message: (e as Error).message }));
      }, pulseMs);
      this.stewardPulseTimer.unref();
    }
    if (pwshProbe.applicable) {
      pwshProbe.configure({ agent: this.agent.available, mode: this.config.agent.pwsh, fetch: () => this.desktop?.fetch });
      this.offPwsh = pwshProbe.onChange((e) => {
        if (e.notice) this.notice(e.notice.level, e.notice.text);
        if (e.kind === "path") void this.agent.refreshIdle();
      });
      void pwshProbe.check();
    }
    void this.prewarmAgent();
    if (this.magpie && !this.opts.noWeb) {
      const tick = () => {
        if (this.account.signedIn || this.magpie?.modelflareInfo().connected) void this.account.refresh();
        void this.refreshBotBudgets();
      };
      setTimeout(tick, 3000).unref();
      this.accountTimer = setInterval(tick, 5 * 60_000);
      this.accountTimer.unref();
    }
  }

  async tellInterrupted(list: Interrupted[]): Promise<void> {
    for (const it of list) {
      const conv = this.store.getConversation(it.conversationId);
      if (!conv) continue;
      const text = interruptedText(it.preview);
      const ch = this.channels.get(conv.account || conv.botId);
      let sent = false;
      try {
        if (conv.channel === "web") {
          this.store.addMessage(conv.id, "assistant", text);
          sent = true;
        } else if (conv.channel === "weixin" && ch?.weixin) sent = await ch.weixin.notify(conv.peerId, text);
        else if (conv.channel === "feishu" && ch?.feishu) sent = await ch.feishu.notify(conv.peerId, text);
        else if (isMessenger(conv.channel)) sent = !!ch?.messengers?.[conv.channel]?.notify(conv.peerId, text);
      } catch (e) {
        log.warn("restart notice failed", { conversationId: conv.id, message: (e as Error).message.slice(0, 200) });
      }
      if (!sent) deferNotice(this.store, conv.id, text);
      log.info("message interrupted by the last exit", { conversationId: conv.id, since: it.at, told: sent ? "now" : "with the next message" });
    }
  }

  async stop(): Promise<void> {
    this.runtime.shutdown();
    this.tasks.stop();
    this.attention.stop();
    this.offPwsh?.();
    if (this.accountTimer) clearInterval(this.accountTimer);
    if (this.picksTimer) clearInterval(this.picksTimer);
    if (this.modelPoolSyncTimer) {
      clearInterval(this.modelPoolSyncTimer);
      this.modelPoolSyncTimer = undefined;
    }
    await this.stewardService.wechatEnvoyPoller.stop();
    if (this.stewardPulseTimer) {
      clearInterval(this.stewardPulseTimer);
      this.stewardPulseTimer = undefined;
    }
    this.account?.cancelLogin();
    this.sugentAuth?.cancelLogin();
    this.hotReloadBus.close();
    await this.web?.close();
    this.delivery.stop();
    await this.outbox.stop();
    for (const id of [...this.channels.keys()]) await this.stopBot(id);
    await this.agent.stop();
    await this.magpie?.stop();
    this.store.close();
    this.lock?.release();
    this.lock = undefined;
  }

  get username(): string {
    try {
      return os.userInfo().username;
    } catch {
      return "";
    }
  }

  // ---------- Modelflare & Multi-Provider Status ----------
  private allowedModelflareUrls(): string[] {
    return [...new Set([...Object.values(MODELFLARE_LINES), modelflareBaseUrl("auto"), modelflareBaseUrl("cn")])];
  }

  modelflareStatus(): ModelflareStatus {
    const line = this.config.modelflare.line;
    if (!this.magpie) return { mode: "external", connected: true, keyTail: "", line, baseUrl: this.config.magpie.externalBaseUrl, gateway: "external" };
    const info = this.magpie.modelflareInfo();
    if (!info.connected && this.providers.hasActiveConnection()) {
      const view = this.providers.publicView();
      const def = view.providers.find((p) => p.isDefault) ?? view.providers[0];
      return {
        mode: "managed",
        connected: true,
        keyTail: def?.keyTail ?? "",
        line,
        baseUrl: def?.baseUrl ?? "",
        gateway: this.magpie.state,
      };
    }
    return { mode: "managed", connected: info.connected, keyTail: info.keyTail, line, baseUrl: info.baseUrl || modelflareBaseUrl(line), gateway: this.magpie.state };
  }

  async connectModelflare(apiKey: string, line: ModelflareLine): Promise<VerifyResult> {
    if (!this.magpie) throw new Error(t("app.external_mode"));
    const baseUrl = modelflareBaseUrl(line);
    const r = await verifyModelflareKey(baseUrl, apiKey.trim(), { line });
    if (!r.ok) return r;
    await this.magpie.connectModelflare(apiKey, baseUrl, this.allowedModelflareUrls(), this.requestHeaders(), r.chatModels);
    this.modelInfoCache = undefined;
    this.setModelflareLineConfig(line);
    await this.runtime.listModels(true).catch(() => []);
    void this.prewarmAgent();
    return r;
  }

  async setModelflareLine(line: ModelflareLine): Promise<void> {
    if (this.magpie && this.magpie.modelflareInfo().connected) await this.magpie.setModelflareUrl(modelflareBaseUrl(line), this.allowedModelflareUrls());
    this.setModelflareLineConfig(line);
  }

  private setModelflareLineConfig(line: ModelflareLine): void {
    this.config.modelflare.line = line;
    saveConfigFile(this.config.dataDir, (f) => (f.modelflare = { ...(f.modelflare ?? {}), line }));
  }

  async disconnectModelflare(): Promise<void> {
    if (!this.magpie) throw new Error(t("app.external_mode"));
    await this.magpie.disconnectModelflare();
    await this.runtime.listModels(true).catch(() => []);
  }

  setDefaultModel(model: string): void {
    this.config.llm.defaultModel = model;
    saveConfigFile(this.config.dataDir, (f) => (f.llm = { ...(f.llm ?? {}), defaultModel: model }));
  }

  webSearchView(): WebSearchView {
    return this.search.view();
  }

  setWebSearch(patch: { provider?: SearchProvider; key?: string; url?: string }): WebSearchView {
    const next: WebSearchSettings = { ...this.webSearch, keys: { ...this.webSearch.keys } };
    if (patch.provider) next.provider = patch.provider;
    const p = next.provider;
    if (patch.key !== undefined && p !== "auto" && p !== "searxng") {
      if (patch.key) next.keys[p] = patch.key;
      else delete next.keys[p];
    }
    if (patch.url !== undefined) next.url = patch.url;
    saveWebSearch(this.store, next);
    this.webSearch = next;
    log.info("web search settings changed", { provider: p, key: p !== "auto" && p !== "searxng" && !!next.keys[p], url: !!next.url });
    return this.search.view();
  }

  setMediaModels(patch: { imageModel?: string; videoModel?: string }): void {
    Object.assign(this.config.media, patch);
    saveConfigFile(this.config.dataDir, (f) => (f.media = { ...(f.media ?? {}), ...patch }));
  }

  async mediaModels(): Promise<{ image: string[]; video: string[]; recommended: { image: string; video: string }; error?: string }> {
    const media = this.agent.media;
    const key = this.botKey("default");
    const empty = { image: [], video: [], recommended: { image: "", video: "" } };
    if (!media || !key || !this.isLegacyModelflareActive()) return empty;
    try {
      const [image, video] = await Promise.all([media.available(key, "image"), media.available(key, "video")]);
      return {
        image: image.map((m) => m.id),
        video: video.map((m) => m.id),
        recommended: { image: pickDefault(image, "")?.id ?? "", video: pickDefault(video, "")?.id ?? "" },
      };
    } catch (e) {
      return { ...empty, error: (e as Error).message };
    }
  }

  private seedDefaultBot(): void {
    if (this.store.listBots().length) return;
    const bot = this.store.createBot({
      id: "default",
      name: t("app.default_bot_name"),
      systemPrompt: t("app.default_bot_prompt"),
      feishuAppId: process.env.FEISHU_APP_ID ?? "",
      feishuAppSecret: process.env.FEISHU_APP_SECRET ?? "",
      weixinEnabled: true,
      settings: normalizeSettings({ avatar: "blue" }),
    });
    log.info(`created default bot ${bot.id}`, { feishuAppId: bot.feishuAppId || "(未配置)" });
  }

  private adoptBotChannels(botId: string): void {
    const bot = this.store.getBot(botId);
    if (!bot) return;
    if (bot.feishuAppId) {
      const cur = this.store.getChannelAccount(botId, "feishu");
      this.store.saveChannelAccount({
        key: botId,
        channel: "feishu",
        label: cur?.label ?? this.freeChannelLabel("feishu", bot.name),
        defaultBot: cur?.defaultBot ?? botId,
        enabled: cur?.enabled ?? true,
        credentials: { appId: bot.feishuAppId, appSecret: bot.feishuAppSecret },
        createdAt: cur?.createdAt ?? Date.now(),
      });
      this.store.updateBot(botId, { feishuAppId: "", feishuAppSecret: "" });
    }
    if (this.store.getWeixinAccount(botId)) this.ensureChannelAccount(botId, "weixin", bot.name, bot.weixinEnabled);
    for (const id of MESSENGERS) if (this.store.getMessengerAccount(botId, id)) this.ensureChannelAccount(botId, id, bot.name);
  }

  private freeChannelLabel(channel: string, wanted: string): string {
    const raw = wanted.trim().slice(0, 76);
    const fallback = channel === "weixin" ? t("app.weixin_account_name") : channel === "feishu" ? t("app.feishu_account_name") : (MESSENGER_LABEL[channel as MessengerId] ?? channel);
    const base = !raw || /^\d+$/.test(raw) ? fallback : raw;
    const taken = new Set(this.store.listChannelAccounts(channel).map((a) => a.label.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
  }

  private ensureChannelAccount(key: string, channel: string, label: string, enabled = true): ChannelAccount {
    const cur = this.store.getChannelAccount(key, channel);
    if (cur) return cur;
    const account: ChannelAccount = { key, channel, label: this.freeChannelLabel(channel, label), defaultBot: defaultBotFor(this.store, key, channel), enabled, credentials: {}, createdAt: Date.now() };
    this.store.saveChannelAccount(account);
    return account;
  }

  async startBot(key: string): Promise<void> {
    this.adoptBotChannels(key);
    const ch: BotChannels = this.channels.get(key) ?? {};
    this.channels.set(key, ch);
    const route = (channel: string) => (peer: string) => botForPeer(this.store, key, channel, peer);
    const nameOf = (channel: string) => this.store.getChannelAccount(key, channel)?.label ?? key;

    const fsAccount = this.store.getChannelAccount(key, "feishu");
    const { appId, appSecret } = fsAccount?.credentials ?? {};
    if (fsAccount?.enabled && appId && appSecret && !ch.feishu) {
      registerSecret(appSecret);
      const brand = fsAccount.credentials.brand === "lark" ? "lark" : "feishu";
      const transport = this.opts.feishuTransport?.({ id: key, feishuAppId: appId, feishuAppSecret: appSecret, brand }) ?? new LarkTransport(appId, appSecret, brand);
      ch.feishu = new FeishuChannel(key, transport, this.runtime, this.queue, this.config.feishu.throttleMs, this.outbox, this.store);
      ch.feishu.delivery = this.delivery;
      ch.feishu.route = route("feishu");
      ch.feishu.onHistoryDenied = () => this.notice("warn", t("app.feishu_history_denied", { name: nameOf("feishu") }));
      const fsCh = ch.feishu;
      this.runtime.registerReplier(key, "feishu", (conv, handle, wakeKey) => (handle?.messageId ? { out: fsCh.followUp(conv.peerId, handle.messageId, wakeKey, conv.botId) } : undefined));
      ch.feishuError = undefined;
      const feishu = ch.feishu;
      detached(() => feishu.start()).catch((e) => {
        ch.feishuError = (e as Error).message;
        this.notice("warn", t("app.feishu_failed", { name: nameOf("feishu"), message: ch.feishuError }));
      });
      log.info(`account ${key}: feishu starting`, { appId, secret: mask(appSecret) });
    }

    registerSecret(this.store.getWeixinAccount(key)?.botToken);
    const wxGuard = this.weixinGuard();
    if (wxGuard.blocked) {
      log.info(`account ${key}: weixin skipped by single-holder guard`, {
        nodeId: wxGuard.nodeId,
        ownerNodeId: wxGuard.ownerNodeId,
      });
    } else if (this.store.getChannelAccount(key, "weixin")?.enabled && !ch.weixin) {
      ch.weixin = new WeixinChannel(key, this.store, this.runtime, this.queue, {
        fetchImpl: this.opts.weixinFetch,
        cdnBaseUrl: this.config.weixin.cdnBaseUrl,
        pollTimeoutMs: this.opts.weixinPollTimeoutMs,
        outbox: this.outbox,
        delivery: this.delivery,
      });
      ch.weixin.route = route("weixin");
      ch.weixin.onExpired = () => {
        this.notice("warn", t("app.weixin_expired", { name: nameOf("weixin") }));
        this.attention.kick();
      };
      const wx = ch.weixin;
      this.runtime.registerReplier(key, "weixin", (conv, _handle, wakeKey) => ({ out: wx.followUp(conv.peerId, wakeKey, conv.botId) }));
      detached(() => wx.start());
    }
    for (const id of MESSENGERS) this.startMessenger(key, id, ch);
  }

  private startMessenger(key: string, id: MessengerId, ch: BotChannels): void {
    const acct = this.store.getMessengerAccount(key, id);
    if (!acct || ch.messengers?.[id] || this.store.getChannelAccount(key, id)?.enabled === false) return;
    for (const secret of Object.values(acct.credentials)) registerSecret(secret);
    const transport = this.opts.messengerTransport?.(id, key, acct.credentials) ?? createTransport(id, key, acct.credentials, this.store);
    const channel = new MessengerChannel(key, transport, this.runtime, this.queue, this.outbox);
    channel.delivery = this.delivery;
    channel.route = (peer) => botForPeer(this.store, key, id, peer);
    channel.onFatal = (detail) => {
      (ch.messengerErrors ??= {})[id] = detail;
      this.notice("warn", t("app.messenger_failed", { name: this.store.getChannelAccount(key, id)?.label ?? key, channel: MESSENGER_LABEL[id], message: detail }));
    };
    (ch.messengers ??= {})[id] = channel;
    if (ch.messengerErrors) delete ch.messengerErrors[id];
    this.runtime.registerReplier(key, id, (conv, _handle, wakeKey) => ({ out: channel.followUp(conv.peerId, wakeKey, conv.botId) }));
    detached(() => channel.start()).catch((e) => channel.onFatal?.((e as Error).message));
    log.info(`account ${key}: ${id} starting`);
  }

  private async stopMessenger(key: string, id: MessengerId): Promise<void> {
    const ch = this.channels.get(key);
    this.runtime.registerReplier(key, id, undefined);
    await ch?.messengers?.[id]?.stop().catch(() => {});
    if (ch?.messengers) delete ch.messengers[id];
    if (ch?.messengerErrors) delete ch.messengerErrors[id];
  }

  async connectMessenger(key: string, id: MessengerId, input: Record<string, unknown>): Promise<void> {
    const old = this.store.getMessengerAccount(key, id);
    const credentials: Record<string, string> = {};
    for (const field of MESSENGER_FIELDS[id]) {
      credentials[field] = String(input[field] ?? "").trim() || (old?.credentials[field] ?? "");
      if (!credentials[field]) throw new PlatformError(t("channel.messengerMissing", { channel: MESSENGER_LABEL[id] }), true);
    }
    const transport = this.opts.messengerTransport?.(id, key, credentials) ?? createTransport(id, key, credentials, this.store);
    let name = old?.name ?? "";
    try {
      name = (await transport.verify?.())?.name ?? name;
    } catch (e) {
      if ((e as PlatformError).rejected) throw e;
      log.warn("couldn't verify the credentials now, saving anyway", { channel: id, message: (e as Error).message.slice(0, 200) });
    }
    const changed = MESSENGER_FIELDS[id].some((f) => f !== "appToken" && credentials[f] !== old?.credentials[f]);
    await this.stopMessenger(key, id);
    if (changed) {
      this.access.resetOwner(key, id);
      if (id === "telegram") this.store.deleteKV(telegramOffsetKey(key));
    }
    this.store.saveMessengerAccount({ botId: key, channel: id, credentials, name });
    this.ensureChannelAccount(key, id, name || MESSENGER_LABEL[id]);
    await this.startBot(key);
  }

  async disconnectMessenger(key: string, id: MessengerId): Promise<void> {
    await this.stopMessenger(key, id);
    this.access.resetOwner(key, id);
    this.store.deleteMessengerAccount(key, id);
    this.store.deleteChannelAccount(key, id);
    if (id === "telegram") this.store.deleteKV(telegramOffsetKey(key));
  }

  async connectFeishu(key: string, appId: string, appSecret: string, brand?: "feishu" | "lark"): Promise<void> {
    if (!appId) return this.removeFeishu(key);
    const cur = this.store.getChannelAccount(key, "feishu");
    const same = appId === cur?.credentials.appId;
    if (!same) this.access.resetOwner(key, "feishu");
    const base = this.ensureChannelAccount(key, "feishu", t("app.feishu_account_name"));
    const lark = (brand ?? (same ? cur?.credentials.brand : undefined)) === "lark";
    this.store.saveChannelAccount({ ...base, credentials: { appId, appSecret: appSecret || cur?.credentials.appSecret || "", ...(lark ? { brand: "lark" } : {}) } });
    await this.stopFeishu(key);
    await this.startBot(key);
  }

  private async stopFeishu(key: string): Promise<void> {
    const ch = this.channels.get(key);
    this.runtime.registerReplier(key, "feishu", undefined);
    await ch?.feishu?.stop().catch(() => {});
    if (ch) {
      ch.feishu = undefined;
      ch.feishuError = undefined;
    }
  }

  private async removeFeishu(key: string): Promise<void> {
    await this.stopFeishu(key);
    this.access.resetOwner(key, "feishu");
    this.store.deleteChannelAccount(key, "feishu");
  }

  channelAccounts() {
    const seen: Record<string, number> = {};
    return this.store.listChannelAccounts().map((a) => {
      seen[a.channel] = (seen[a.channel] ?? 0) + 1;
      const status = this.channelStatus(a.key) as unknown as Record<string, ChannelStatus>;
      return {
        key: a.key,
        channel: a.channel,
        number: seen[a.channel],
        label: a.label,
        defaultBot: defaultBotFor(this.store, a.key, a.channel),
        enabled: a.enabled,
        status: status[a.channel],
        requests: this.store.listAccess({ botId: a.key, channel: a.channel, status: "pending" }).length,
      };
    });
  }

  async updateChannelAccount(key: string, channel: string, patch: { label?: string; defaultBot?: string; enabled?: boolean }): Promise<"ok" | "missing" | "invalid" | "taken" | "no-bot"> {
    const cur = this.store.getChannelAccount(key, channel);
    if (!cur) return "missing";
    const next = { ...cur };
    if (patch.label !== undefined) {
      const name = patch.label.trim().slice(0, 80);
      if (!name || /^\d+$/.test(name)) return "invalid";
      if (this.store.listChannelAccounts(channel).some((a) => a.key !== key && a.label.toLowerCase() === name.toLowerCase())) return "taken";
      next.label = name;
    }
    if (patch.defaultBot !== undefined) {
      if (!this.store.getBot(patch.defaultBot)) return "no-bot";
      next.defaultBot = patch.defaultBot;
    }
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    this.store.saveChannelAccount(next);
    if (patch.enabled !== undefined && patch.enabled !== cur.enabled) await this.restartBot(key);
    return "ok";
  }

  async removeChannelAccount(key: string, channel: string): Promise<void> {
    if (channel === "feishu") await this.removeFeishu(key);
    else if (channel === "weixin") await this.weixinLogout(key);
    else if (isMessenger(channel)) await this.disconnectMessenger(key, channel);
    for (const e of this.store.listAccess({ botId: key, channel })) this.access.remove(e.id);
  }

  private messengerStatus(key: string, id: MessengerId): ChannelStatus & { account?: { name: string; saved: Record<string, string> } } {
    const acct = this.store.getMessengerAccount(key, id);
    if (!acct) return { state: "disabled", since: 0 };
    const ch = this.channels.get(key);
    const error = ch?.messengerErrors?.[id];
    const st: ChannelStatus = error ? { state: "error", detail: error, since: Date.now() } : ch?.messengers?.[id]?.status ?? { state: "disabled", since: 0 };
    return { ...st, account: { name: acct.name, saved: Object.fromEntries(Object.entries(acct.credentials).map(([k, v]) => [k, mask(v)])) } };
  }

  async stopBot(key: string): Promise<void> {
    const ch = this.channels.get(key);
    if (!ch) return;
    ch.weixinLogin?.cancel();
    this.runtime.registerReplier(key, "feishu", undefined);
    this.runtime.registerReplier(key, "weixin", undefined);
    for (const id of MESSENGERS) await this.stopMessenger(key, id);
    await ch.feishu?.stop().catch(() => {});
    await ch.weixin?.stop().catch(() => {});
    this.channels.delete(key);
  }

  async restartBot(key: string): Promise<void> {
    await this.stopBot(key);
    await this.startBot(key);
  }

  startWeixinLogin(key: string): WeixinLogin {
    const wxGuard = this.weixinGuard();
    if (wxGuard.blocked) {
      throw new Error(wxGuard.reason ?? `Weixin channel is exclusively owned by ${wxGuard.ownerNodeId}`);
    }
    const ch = this.channels.get(key) ?? {};
    this.channels.set(key, ch);
    ch.weixinLogin?.cancel();
    const login = new WeixinLogin({
      apiBaseUrl: this.config.weixin.apiBaseUrl,
      pngPath: path.join(this.config.dataDir, "weixin", `${key}-login-qr.png`),
      fetchImpl: this.opts.weixinFetch,
      printTerminal: this.opts.printQrToTerminal ?? true,
      pollDelayMs: this.opts.weixinFetch ? 50 : 1000,
    });
    ch.weixinLogin = login;
    void login.run().then(async (res) => {
      if (!res) return;
      const prevOwner = this.store.getWeixinAccount(key)?.ownerUserId;
      this.store.saveWeixinAccount({ botId: key, botToken: res.botToken, ilinkBotId: res.ilinkBotId, baseUrl: res.baseUrl, ownerUserId: res.userId });
      if (prevOwner && prevOwner !== res.userId) this.access.allow(key, "weixin", prevOwner, "previous-owner");
      if (res.userId) this.access.resetOwner(key, "weixin", { keep: true });
      const account = this.ensureChannelAccount(key, "weixin", t("app.weixin_account_name"));
      if (!account.enabled) this.store.saveChannelAccount({ ...account, enabled: true });
      await ch.weixin?.stop();
      ch.weixin = undefined;
      await this.startBot(key);
      this.notice("info", t("app.weixin_connected", { name: account.label }));
    });
    return login;
  }

  async weixinLogout(key: string): Promise<void> {
    const ch = this.channels.get(key);
    await ch?.weixin?.stop();
    if (ch) ch.weixin = undefined;
    this.runtime.registerReplier(key, "weixin", undefined);
    this.store.deleteWeixinAccount(key);
    this.store.deleteChannelAccount(key, "weixin");
  }

  channelStatus(key: string): { feishu: ChannelStatus; weixin: ChannelStatus & { login?: unknown; quota?: unknown } } & Record<MessengerId, ChannelStatus> {
    const ch = this.channels.get(key);
    const fsAccount = this.store.getChannelAccount(key, "feishu");
    const feishu: ChannelStatus & { account?: { appId: string; saved: { appSecret: string } } } = !fsAccount?.credentials.appId
      ? { state: "disabled", detail: t("channel.feishu_no_credentials"), since: 0 }
      : ch?.feishuError
        ? { state: "error", detail: ch.feishuError, since: Date.now() }
        : ch?.feishu?.status ?? { state: "disabled", since: 0 };
    if (fsAccount?.credentials.appId) feishu.account = { appId: fsAccount.credentials.appId, saved: { appSecret: mask(fsAccount.credentials.appSecret) } };
    const acct = this.store.getWeixinAccount(key);
    const wxGuard = this.weixinGuard();
    const wx = wxGuard.blocked
      ? { state: "disabled" as const, detail: wxGuard.reason, since: 0 }
      : (ch?.weixin?.status ?? (acct ? { state: "disabled" as const, since: 0 } : { state: "login_required" as const, detail: t("channel.wx_login_required"), since: 0 }));
    const quota = ch?.weixin
      ? this.store.listWeixinPeers(key).map((p) => ({ userId: p.userId, remaining: ch.weixin!.quota.remaining(p.userId), windowStartedAt: p.windowStartedAt }))
      : [];
    return {
      feishu,
      weixin: {
        ...wx,
        ...(acct ? { account: { ilinkBotId: acct.ilinkBotId, pausedUntil: acct.pausedUntil } } : {}),
        login: ch?.weixinLogin?.snapshot,
        quota,
      },
      telegram: this.messengerStatus(key, "telegram"),
      slack: this.messengerStatus(key, "slack"),
      discord: this.messengerStatus(key, "discord"),
    };
  }
}
