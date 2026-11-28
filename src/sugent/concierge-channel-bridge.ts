import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { eventText, type InboundEvent } from "../core/types.js";
import type {
  ConciergeCloudMode,
  ConciergeIntentCategory,
  ConciergeModelPort,
  ModelAssessmentRawOutput,
} from "./concierge-assessor.js";
import {
  parseOwnerCommand,
  type CommandExecutionOutcome,
  type OutboundChannelTransport,
  type SuspendedRoundRecord,
  type SuspendedRoundStorePort,
} from "./concierge-dispatcher.js";
import type {
  AccessControlPort,
  ConciergeChannelKind,
  RawChannelMessage,
} from "./concierge-envelope.js";
import {
  createSugentGraphRecallAdapter,
  type KnowledgeGraphEdgeLike,
  type KnowledgeGraphNodeLike,
} from "./concierge-subgraph.js";
import type { SugentKnowledgeGraph } from "./knowledge-graph.js";
import { OpcConciergeOrchestrator, type ConciergeRouteOutcome } from "./opc-concierge.js";
import type { StewardshipLedger } from "./stewardship-ledger.js";

export interface ConciergeAssessorEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ConciergeBridgeConfig {
  enabled: boolean;
  ownerDisplayName: string;
  cloudMode: ConciergeCloudMode;
  coolingWindowMs: number;
  explicitAssistantWhitelistPeerIds: string[];
}

export interface ConciergeTransportOverride {
  notifyOwner?: (
    channel: ConciergeChannelKind,
    text: string,
    feishuCardPayload?: Record<string, unknown>,
  ) => Promise<void>;
  sendPeerDirectMessage?: (
    channel: ConciergeChannelKind,
    peerId: string,
    text: string,
  ) => Promise<void>;
  sendToPeer?: (
    channel: ConciergeChannelKind,
    peerId: string,
    text: string,
  ) => Promise<void>;
}

export interface ConciergeChannelBridgeOptions {
  dataDir: string;
  knowledgeGraph: SugentKnowledgeGraph;
  ledger?: StewardshipLedger;
  resolveAssessorEndpoint?: () => ConciergeAssessorEndpoint | undefined;
  fetchImpl?: typeof fetch;
  resolveActorRole: (params: {
    channel: ConciergeChannelKind;
    botId: string;
    account?: string;
    conversationId: string;
    senderId: string;
  }) => "owner" | "external_peer";
  defaultTransport: OutboundChannelTransport;
}

const CONFIG_FILENAME = "sugent-concierge.json";

function normalizeCloudMode(raw: unknown, fallback: ConciergeCloudMode): ConciergeCloudMode {
  if (raw === "none" || raw === "byok_local" || raw === "sugent_cloud") {
    return raw;
  }
  if (raw === "local_trusted") return "none";
  if (raw === "cloud_sanitized") return "byok_local";
  return fallback;
}

function sanitizeEventId(rawId: string): string {
  const cleaned = rawId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 72);
  return cleaned.length >= 3 ? cleaned : `evt_${cleaned}_${crypto.randomBytes(3).toString("hex")}`;
}

function extractPeerScopeFromNode(id: string, tags: readonly string[]): string | undefined {
  if (id.startsWith("peer:")) {
    return id.slice("peer:".length);
  }
  if (id.startsWith("rel:")) {
    return id.slice("rel:".length);
  }
  for (const tag of tags) {
    if (tag.startsWith("peer:")) {
      return tag.slice("peer:".length);
    }
    if (tag.startsWith("rel:")) {
      return tag.slice("rel:".length);
    }
    if (tag === "public_catalog" || tag === "public") {
      return "public_catalog";
    }
  }
  return undefined;
}

function extractConfidentialTokens(summary: string): string[] {
  const matches = summary.match(/[A-Za-z0-9_]{5,}/g) ?? [];
  return matches.filter((tok) => /[A-Z_]/.test(tok) || /\d/.test(tok));
}

function buildLocalDeterministicAssessor(ownerDisplayName: string): ConciergeModelPort {
  return {
    async generateAssessment(req): Promise<ModelAssessmentRawOutput> {
      let bodySection = "";
      try {
        const rawDoc = fs.readFileSync(req.untrustedContextFilePath, "utf8");
        const markerIdx = rawDoc.indexOf("## Raw Message Payload");
        bodySection =
          markerIdx >= 0
            ? rawDoc.slice(markerIdx).split("\n").slice(1).join(" ").trim()
            : rawDoc.trim();
      } catch {
        bodySection = "";
      }

      const compact = bodySection.slice(0, 80) || "来访咨询";
      let intentCategory: ConciergeIntentCategory = "general_inquiry";
      let autoReplyDraft: string | undefined;

      if (/(预约|会议|日程|排期|演示|沟通时间|meeting|schedule|book)/i.test(bodySection)) {
        intentCategory = "appointment_scheduling";
        autoReplyDraft = `您好！已为您登记本次预约与排期诉求，${ownerDisplayName}确认具体时段后将第一时间与您同步日程邀请。`;
      } else if (/(流程|标准服务|介绍|手册|资料|怎么合作|faq|brochure)/i.test(bodySection)) {
        intentCategory = "standard_brochure";
        autoReplyDraft = `您好！已收到您的服务流程咨询，正在为您调取最新标准服务说明，${ownerDisplayName}稍后与您进一步对接。`;
      } else if (/(工单|报修|故障|进度查询|ticket|issue)/i.test(bodySection)) {
        intentCategory = "ticket_intake";
        autoReplyDraft = `您好！您的事项已登记跟进工单，${ownerDisplayName}核实处理进展后将及时向您反馈。`;
      }

      return {
        intentCategory,
        summary: `客户来信要点：${compact}`,
        draftA: "收到您的消息，我先核对一下当前项目排期与具体范围，稍后详细回复您。",
        draftB: "您好，您的需求我已收到，今天内整理好诊断流程与合作方式发您对齐。",
        ...(autoReplyDraft ? { autoReplyDraft } : {}),
      };
    },
  };
}

export class ConciergeChannelBridge {
  private readonly configPath: string;
  private readonly workspaceDir: string;
  private readonly knowledgeGraph: SugentKnowledgeGraph;
  private ledger?: StewardshipLedger;
  private readonly resolveAssessorEndpoint?: () => ConciergeAssessorEndpoint | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly resolveActorRoleFn: ConciergeChannelBridgeOptions["resolveActorRole"];
  private readonly defaultTransport: OutboundChannelTransport;
  private transportOverride: ConciergeTransportOverride | null = null;
  private modelPortOverride: ConciergeModelPort | null = null;
  private config: ConciergeBridgeConfig;
  private orchestrator: OpcConciergeOrchestrator;
  private readonly suspendedRounds = new Map<string, SuspendedRoundRecord>();
  private readonly inflightTasks = new Set<Promise<unknown>>();
  private readonly lastInboundBySender = new Map<string, InboundEvent>();
  private readonly consoleOwnerSenders = new Set<string>();

  constructor(options: ConciergeChannelBridgeOptions) {
    this.configPath = path.join(options.dataDir, CONFIG_FILENAME);
    this.workspaceDir = path.join(options.dataDir, "concierge-workspace");
    this.knowledgeGraph = options.knowledgeGraph;
    this.ledger = options.ledger;
    this.resolveAssessorEndpoint = options.resolveAssessorEndpoint;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.resolveActorRoleFn = options.resolveActorRole;
    this.defaultTransport = options.defaultTransport;
    this.config = this.loadConfigFromDisk();
    this.orchestrator = this.buildOrchestrator();
  }

  private loadConfigFromDisk(): ConciergeBridgeConfig {
    const fallback: ConciergeBridgeConfig = {
      enabled: false,
      ownerDisplayName: "主理人",
      cloudMode: "byok_local",
      coolingWindowMs: 15_000,
      explicitAssistantWhitelistPeerIds: [],
    };
    if (!fs.existsSync(this.configPath)) {
      return fallback;
    }
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.configPath, "utf8"),
      ) as Record<string, unknown>;
      return {
        enabled: Boolean(parsed.enabled),
        ownerDisplayName:
          typeof parsed.ownerDisplayName === "string" && parsed.ownerDisplayName.trim()
            ? parsed.ownerDisplayName.trim()
            : fallback.ownerDisplayName,
        cloudMode: normalizeCloudMode(parsed.cloudMode, fallback.cloudMode),
        coolingWindowMs:
          typeof parsed.coolingWindowMs === "number" &&
          Number.isFinite(parsed.coolingWindowMs) &&
          parsed.coolingWindowMs >= 10
            ? Math.round(parsed.coolingWindowMs)
            : fallback.coolingWindowMs,
        explicitAssistantWhitelistPeerIds: Array.isArray(parsed.explicitAssistantWhitelistPeerIds)
          ? parsed.explicitAssistantWhitelistPeerIds.map((x) => String(x).trim()).filter(Boolean)
          : [],
      };
    } catch {
      return fallback;
    }
  }

  private saveConfigToDisk(): void {
    const dir = path.dirname(this.configPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.configPath}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.config, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.configPath);
  }

  private createTransportProxy(): OutboundChannelTransport {
    return {
      notifyOwner: async (channel, text, feishuCardPayload) => {
        if (this.transportOverride?.notifyOwner) {
          await this.transportOverride.notifyOwner(channel, text, feishuCardPayload);
          return;
        }
        await this.defaultTransport.notifyOwner(channel, text, feishuCardPayload);
      },
      sendPeerDirectMessage: async (channel, peerId, text) => {
        const overridePeerFn =
          this.transportOverride?.sendPeerDirectMessage ?? this.transportOverride?.sendToPeer;
        if (overridePeerFn) {
          await overridePeerFn(channel, peerId, text);
          return;
        }
        await this.defaultTransport.sendPeerDirectMessage(channel, peerId, text);
      },
    };
  }

  private createAccessPort(): AccessControlPort {
    return {
      resolveRole: (channel, senderId) => {
        if (this.consoleOwnerSenders.has(`${channel}:${senderId}`)) {
          return "owner";
        }
        const ev = this.lastInboundBySender.get(`${channel}:${senderId}`);
        if (ev?.conversation.kind === "group") {
          return "external_peer";
        }
        return this.resolveActorRoleFn({
          channel,
          botId: ev?.botId ?? "default",
          ...(ev?.account ? { account: ev.account } : {}),
          conversationId: ev?.conversation.id ?? senderId,
          senderId,
        });
      },
    };
  }

  private buildOrchestrator(): OpcConciergeOrchestrator {
    fs.mkdirSync(this.workspaceDir, { recursive: true, mode: 0o700 });
    const suspendedStore: SuspendedRoundStorePort = {
      suspendRound: (record) => {
        this.suspendedRounds.set(record.cardId, record);
      },
      resolveRound: (cardId) => {
        this.suspendedRounds.delete(cardId);
      },
      getSuspendedRound: (cardId) => this.suspendedRounds.get(cardId),
    };

    const graphPort = createSugentGraphRecallAdapter(this.knowledgeGraph, (graphInstance) => {
      const snap = graphInstance.recallSubgraph("", 2, 500);
      const nodes: KnowledgeGraphNodeLike[] = [];
      const seenNodeIds = new Set<string>();
      for (const n of snap.matchedNodes) {
        const peerScope = extractPeerScopeFromNode(n.id, n.tags);
        const isPeerOrPerson = n.kind === "person" || n.id.startsWith("rel:") || n.id.startsWith("peer:");
        if (!isPeerOrPerson && peerScope === undefined) continue;
        seenNodeIds.add(n.id);
        nodes.push({
          id: n.id,
          label: n.name,
          kind: n.kind,
          ...(peerScope ? { peerScope } : {}),
          summary: n.summary,
          confidentialTokens: isPeerOrPerson ? extractConfidentialTokens(n.summary) : [],
        });
      }
      if (this.ledger) {
        for (const rel of this.ledger.snapshotForCaller("owner_private").relationships) {
          const relNodeId = `rel:${rel.id}`;
          if (seenNodeIds.has(relNodeId)) continue;
          seenNodeIds.add(relNodeId);
          const detail = [
            rel.roleTag,
            ...(rel.taboos.length ? [`忌讳:${rel.taboos.join("/")}`] : []),
            ...(rel.preferences.length ? [`偏好:${rel.preferences.join("/")}`] : []),
          ]
            .filter(Boolean)
            .join("；");
          nodes.push({
            id: relNodeId,
            label: rel.name,
            kind: "person",
            peerScope: rel.id,
            summary: detail || rel.name,
            confidentialTokens: extractConfidentialTokens(detail),
          });
        }
      }
      const edges: KnowledgeGraphEdgeLike[] = snap.activeEdges
        .filter((e) => seenNodeIds.has(e.from) && seenNodeIds.has(e.to))
        .map((e) => ({
          from: e.from,
          to: e.to,
          relation: e.relation,
        }));
      return { nodes, edges };
    });

    const fallbackAssessor = buildLocalDeterministicAssessor(this.config.ownerDisplayName);
    const modelPort: ConciergeModelPort = {
      generateAssessment: async (req) => {
        if (this.modelPortOverride) {
          return this.modelPortOverride.generateAssessment(req);
        }
        const endpoint = this.resolveAssessorEndpoint?.();
        if (endpoint?.baseUrl && endpoint?.model) {
          const live = await this.callAssessorEndpoint(endpoint, req);
          if (live) return live;
        }
        return fallbackAssessor.generateAssessment(req);
      },
    };

    return new OpcConciergeOrchestrator({
      workspaceDir: this.workspaceDir,
      ownerDisplayName: this.config.ownerDisplayName,
      cloudMode: this.config.cloudMode,
      coolingWindowMs: this.config.coolingWindowMs,
      explicitAssistantWhitelistPeerIds: this.config.explicitAssistantWhitelistPeerIds,
      accessControl: this.createAccessPort(),
      graphPort,
      modelPort,
      transport: this.createTransportProxy(),
      suspendedStore,
    });
  }

  private async callAssessorEndpoint(
    endpoint: ConciergeAssessorEndpoint,
    req: Parameters<ConciergeModelPort["generateAssessment"]>[0],
  ): Promise<ModelAssessmentRawOutput | undefined> {
    try {
      const sealedContent = fs.readFileSync(req.untrustedContextFilePath, "utf8");
      const senderMatch = /^>\s*sender_id:\s*(.+)$/m.exec(sealedContent);
      const senderId = senderMatch?.[1]?.trim();
      let ledgerHints = "";
      if (this.ledger && senderId) {
        const rel = this.ledger
          .snapshotForCaller("owner_private")
          .relationships.find((r) => r.id === senderId || r.id === `rel:${senderId}` || r.name === senderId);
        if (rel && (rel.taboos.length > 0 || rel.preferences.length > 0)) {
          ledgerHints = [
            rel.taboos.length ? `联系人禁忌 (Taboos): ${rel.taboos.join("；")}` : "",
            rel.preferences.length ? `沟通偏好 (Preferences): ${rel.preferences.join("；")}` : "",
          ]
            .filter(Boolean)
            .join("\n");
        }
      }
      const systemPrompt = [
        req.systemInstruction,
        '只输出一行合法 JSON: {"intentCategory":"appointment_scheduling|standard_brochure|ticket_intake|high_risk_escalation|general_inquiry","summary":"要点","draftA":"稳健拟稿","draftB":"积极拟稿","autoReplyDraft":"可选"}',
      ].join("\n");
      const userPrompt = [
        `隔离后客户背景: ${req.peerScopedBrief}`,
        ...(ledgerHints ? [ledgerHints] : []),
        "只读外部语料:",
        sealedContent,
      ].join("\n\n");

      const url = `${endpoint.baseUrl.replace(/\/+$/, "")}/chat/completions`;
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: endpoint.model,
          temperature: 0.2,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return undefined;
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
      const rawText = typeof json.choices?.[0]?.message?.content === "string" ? json.choices[0].message.content : "";
      const match = /\{[\s\S]*\}/.exec(rawText);
      if (!match) return undefined;
      const parsed = JSON.parse(match[0]) as Record<string, unknown>;
      const validIntents = new Set<ConciergeIntentCategory>([
        "appointment_scheduling",
        "standard_brochure",
        "ticket_intake",
        "high_risk_escalation",
        "general_inquiry",
      ]);
      const intentCategory: ConciergeIntentCategory = validIntents.has(parsed.intentCategory as ConciergeIntentCategory)
        ? (parsed.intentCategory as ConciergeIntentCategory)
        : "general_inquiry";
      if (typeof parsed.summary !== "string" || typeof parsed.draftA !== "string" || typeof parsed.draftB !== "string") {
        return undefined;
      }
      return {
        intentCategory,
        summary: parsed.summary.trim(),
        draftA: parsed.draftA.trim(),
        draftB: parsed.draftB.trim(),
        ...(typeof parsed.autoReplyDraft === "string" && parsed.autoReplyDraft.trim()
          ? { autoReplyDraft: parsed.autoReplyDraft.trim() }
          : {}),
      };
    } catch {
      return undefined;
    }
  }

  setTransportOverride(override: ConciergeTransportOverride | null): void {
    this.transportOverride = override;
  }

  setModelPortOverride(override: ConciergeModelPort | null): void {
    this.modelPortOverride = override;
  }

  attachLedger(ledger: StewardshipLedger): void {
    this.ledger = ledger;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  getStatus() {
    return {
      ...this.config,
      suspendedApprovals: Array.from(this.suspendedRounds.values()),
    };
  }

  getWorkbench(nowMs = Date.now()) {
    return {
      ...this.getStatus(),
      ...this.orchestrator.getWorkbenchSnapshot(nowMs),
    };
  }

  updateConfig(patch: Record<string, unknown>) {
    this.config = {
      enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : this.config.enabled,
      ownerDisplayName:
        typeof patch.ownerDisplayName === "string" && patch.ownerDisplayName.trim()
          ? patch.ownerDisplayName.trim()
          : this.config.ownerDisplayName,
      cloudMode:
        patch.cloudMode !== undefined
          ? normalizeCloudMode(patch.cloudMode, this.config.cloudMode)
          : this.config.cloudMode,
      coolingWindowMs:
        typeof patch.coolingWindowMs === "number" &&
        Number.isFinite(patch.coolingWindowMs) &&
        patch.coolingWindowMs >= 10
          ? Math.round(patch.coolingWindowMs)
          : this.config.coolingWindowMs,
      explicitAssistantWhitelistPeerIds: Array.isArray(patch.explicitAssistantWhitelistPeerIds)
        ? patch.explicitAssistantWhitelistPeerIds.map((x) => String(x).trim()).filter(Boolean)
        : this.config.explicitAssistantWhitelistPeerIds,
    };
    this.saveConfigToDisk();
    this.orchestrator = this.buildOrchestrator();
    return this.getStatus();
  }

  private toRawChannelMessage(ev: InboundEvent): RawChannelMessage | null {
    if (ev.channel !== "weixin" && ev.channel !== "feishu") {
      return null;
    }
    const text = eventText(ev).trim();
    if (!text) {
      return null;
    }
    const senderId = ev.conversation.kind === "group" ? ev.sender.id : ev.conversation.id;
    this.lastInboundBySender.set(`${ev.channel}:${senderId}`, ev);
    return {
      eventId: sanitizeEventId(ev.id),
      channel: ev.channel,
      chatType: ev.conversation.kind === "group" ? "group" : "direct",
      senderId,
      senderDisplayName: ev.sender.name || senderId,
      ...(ev.conversation.kind === "group" ? { groupId: ev.conversation.id } : {}),
      text,
      timestampMs: ev.receivedAt || Date.now(),
    };
  }

  interceptRuntimeReply(ev: InboundEvent): { handled: boolean; ack?: string } | undefined {
    if (!this.config.enabled) {
      return undefined;
    }
    if (ev.channel !== "weixin" && ev.channel !== "feishu") {
      return undefined;
    }
    const text = eventText(ev).trim();
    if (!text) {
      return undefined;
    }

    const role =
      ev.conversation.kind === "group"
        ? "external_peer"
        : this.resolveActorRoleFn({
            channel: ev.channel,
            botId: ev.botId,
            ...(ev.account ? { account: ev.account } : {}),
            conversationId: ev.conversation.id,
            senderId: ev.sender.id,
          });

    if (role === "owner") {
      if (!parseOwnerCommand(text)) {
        return undefined;
      }
      this.enqueueTask(this.processInboundEvent(ev));
      return { handled: true };
    }

    this.enqueueTask(this.processInboundEvent(ev));
    return { handled: true };
  }

  private enqueueTask<T>(promise: Promise<T>): void {
    const tracked = promise
      .catch(() => {})
      .finally(() => {
        this.inflightTasks.delete(tracked);
      });
    this.inflightTasks.add(tracked);
  }

  async processInboundEvent(ev: InboundEvent): Promise<ConciergeRouteOutcome> {
    const raw = this.toRawChannelMessage(ev);
    if (!raw) {
      return { routeTaken: "owner_chat_passthrough" };
    }
    return this.orchestrator.handleInboundMessage(raw);
  }

  async ingestWeChatEnvoyEvent(input: {
    message: {
      messageId: string;
      chatId: string;
      isGroup: boolean;
      senderId: string;
      senderName: string;
      text: string;
      timestampMs: number;
    };
  }): Promise<ConciergeRouteOutcome> {
    const m = input.message;
    const text = m.text.trim();
    if (!text) {
      return { routeTaken: "owner_chat_passthrough" };
    }
    const raw: RawChannelMessage = {
      eventId: sanitizeEventId(`wxenv_${m.messageId}`),
      channel: "wechat_envoy",
      chatType: m.isGroup ? "group" : "direct",
      senderId: m.senderId,
      senderDisplayName: m.senderName || m.senderId,
      ...(m.isGroup ? { groupId: m.chatId } : {}),
      text,
      timestampMs: m.timestampMs || Date.now(),
      metadata: {
        mentionedSelf: m.isGroup,
        chatId: m.chatId,
      },
    };
    return this.orchestrator.handleInboundMessage(raw);
  }

  async executeOwnerCommand(
    commandText: string,
    channel: ConciergeChannelKind = "weixin",
  ): Promise<CommandExecutionOutcome> {
    const parsed = parseOwnerCommand(commandText);
    if (!parsed) {
      return { status: "not_found", reason: "Unrecognized owner concierge command" };
    }
    const senderId = "__console_owner__";
    const syntheticOwnerMsg: RawChannelMessage = {
      eventId: sanitizeEventId(`cmd_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`),
      channel,
      chatType: "direct",
      senderId,
      senderDisplayName: this.config.ownerDisplayName,
      text: commandText.trim(),
      timestampMs: Date.now(),
    };
    this.consoleOwnerSenders.add(`${channel}:${senderId}`);
    try {
      const res = await this.orchestrator.handleInboundMessage(syntheticOwnerMsg);
      if (res.routeTaken === "owner_command_handled") {
        return res.commandResult;
      }
      return { status: "not_found", reason: "Command not handled" };
    } finally {
      this.consoleOwnerSenders.delete(`${channel}:${senderId}`);
    }
  }

  async flushPending(): Promise<void> {
    while (this.inflightTasks.size > 0) {
      await Promise.all([...this.inflightTasks]);
    }
  }
}
