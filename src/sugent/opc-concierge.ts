import {
  sealInboundConciergeEvent,
  type AccessControlPort,
  type RawChannelMessage,
} from "./concierge-envelope.js";
import {
  recallPeerIsolatedSubgraph,
  type KnowledgeGraphRecallPort,
} from "./concierge-subgraph.js";
import {
  assessConciergeInbound,
  isLowRiskStandardIntent,
  renderFeishuEarpieceCard,
  renderWeixinEarpieceText,
  type ConciergeCloudMode,
  type ConciergeModelPort,
} from "./concierge-assessor.js";
import {
  ConciergeDispatcher,
  parseOwnerCommand,
  type CommandExecutionOutcome,
  type ConciergeWorkbenchSnapshot,
  type OutboundChannelTransport,
  type SuspendedRoundStorePort,
} from "./concierge-dispatcher.js";

export interface OpcConciergeConfig {
  workspaceDir: string;
  ownerDisplayName: string;
  cloudMode: ConciergeCloudMode;
  coolingWindowMs?: number;
  explicitAssistantWhitelistPeerIds: readonly string[];
  accessControl: AccessControlPort;
  graphPort: KnowledgeGraphRecallPort;
  modelPort?: ConciergeModelPort;
  transport: OutboundChannelTransport;
  suspendedStore: SuspendedRoundStorePort;
}

export type ConciergeRouteOutcome =
  | { routeTaken: "owner_command_handled"; commandResult: CommandExecutionOutcome }
  | { routeTaken: "owner_chat_passthrough" }
  | { routeTaken: "whisper_earpiece"; cardId: string }
  | { routeTaken: "whisper_earpiece_group_digest"; cardId: string }
  | { routeTaken: "explicit_digital_assistant"; cardId: string; dispatchId?: string }
  | { routeTaken: "suspended_for_owner_approval"; approvalId: string };

export class OpcConciergeOrchestrator {
  private readonly config: OpcConciergeConfig;
  private readonly whitelist: ReadonlySet<string>;
  private readonly dispatcher: ConciergeDispatcher;

  constructor(config: OpcConciergeConfig) {
    this.config = config;
    this.whitelist = new Set(config.explicitAssistantWhitelistPeerIds);
    this.dispatcher = new ConciergeDispatcher({
      ownerDisplayName: config.ownerDisplayName,
      ...(config.coolingWindowMs !== undefined ? { coolingWindowMs: config.coolingWindowMs } : {}),
      transport: config.transport,
      suspendedStore: config.suspendedStore,
    });
  }

  getWorkbenchSnapshot(nowMs?: number): ConciergeWorkbenchSnapshot {
    return this.dispatcher.getWorkbenchSnapshot(nowMs);
  }

  async handleInboundMessage(raw: RawChannelMessage): Promise<ConciergeRouteOutcome> {
    const envelope = await sealInboundConciergeEvent(raw, {
      workspaceDir: this.config.workspaceDir,
      accessControl: this.config.accessControl,
    });

    if (envelope.actorRole === "owner") {
      const parsedCmd = parseOwnerCommand(raw.text);
      if (!parsedCmd) {
        return { routeTaken: "owner_chat_passthrough" };
      }
      const commandResult = await this.dispatcher.handleOwnerCommand(parsedCmd);
      return { routeTaken: "owner_command_handled", commandResult };
    }

    const subgraph = recallPeerIsolatedSubgraph(this.config.graphPort, envelope.peerId);

    const assessment = await assessConciergeInbound({
      envelope,
      rawPeerTextForDeterministicScan: raw.text,
      subgraph,
      ownerDisplayName: this.config.ownerDisplayName,
      cloudMode: this.config.cloudMode,
      ...(this.config.modelPort ? { modelPort: this.config.modelPort } : {}),
    });

    const cardId = assessment.receipt.approval?.approvalId ?? `card_${envelope.eventId}`;
    const isRedLine =
      assessment.receipt.status === "suspend_approval" ||
      assessment.redLineInspection.requiresSuspendApproval;

    if (envelope.chatType === "group") {
      this.dispatcher.registerEarpieceCard({
        cardId,
        channel: envelope.channel,
        chatType: "group",
        peerId: envelope.peerId,
        peerDisplayName: envelope.peerDisplayName,
        summary: assessment.summary,
        briefDigest: subgraph.briefDigest,
        riskLevel: "group_locked",
        matchedRedLines: assessment.redLineInspection.matchedDomains,
        createdAtMs: envelope.timestampMs,
        crossPeerCanaryTokens: subgraph.crossPeerCanaryTokens,
        draftA: { body: assessment.optionA.body, confirmHash: assessment.optionA.confirmHash },
        draftB: { body: assessment.optionB.body, confirmHash: assessment.optionB.confirmHash },
      });
      await this.pushOwnerEarpiece(cardId, envelope, subgraph, assessment, false);
      return { routeTaken: "whisper_earpiece_group_digest", cardId };
    }

    this.dispatcher.registerEarpieceCard({
      cardId,
      channel: envelope.channel,
      chatType: "direct",
      peerId: envelope.peerId,
      peerDisplayName: envelope.peerDisplayName,
      summary: assessment.summary,
      briefDigest: subgraph.briefDigest,
      riskLevel: isRedLine ? "red_line" : "normal",
      matchedRedLines: assessment.redLineInspection.matchedDomains,
      createdAtMs: envelope.timestampMs,
      crossPeerCanaryTokens: subgraph.crossPeerCanaryTokens,
      draftA: { body: assessment.optionA.body, confirmHash: assessment.optionA.confirmHash },
      draftB: { body: assessment.optionB.body, confirmHash: assessment.optionB.confirmHash },
    });

    const isWhitelisted = this.whitelist.has(envelope.peerId);

    if (isRedLine) {
      this.config.suspendedStore.suspendRound({
        cardId,
        peerId: envelope.peerId,
        prompt: assessment.summary,
        riskLevel: assessment.receipt.approval?.riskLevel ?? "high",
        createdAtMs: envelope.timestampMs,
      });
      await this.pushOwnerEarpiece(cardId, envelope, subgraph, assessment, true);
      return { routeTaken: "suspended_for_owner_approval", approvalId: cardId };
    }

    if (
      isWhitelisted &&
      isLowRiskStandardIntent(assessment.intentCategory) &&
      assessment.explicitAssistantDraft
    ) {
      const dispatchOutcome = await this.dispatcher.scheduleValidatedOutbound({
        cardId,
        channel: envelope.channel,
        chatType: "direct",
        peerId: envelope.peerId,
        peerDisplayName: envelope.peerDisplayName,
        mode: "explicit_assistant",
        body: assessment.explicitAssistantDraft,
        crossPeerCanaryTokens: subgraph.crossPeerCanaryTokens,
        resolutionTag: "explicit_assistant_auto_sop",
        bypassDoubleConfirm: false,
      });

      if (dispatchOutcome.status === "cooling_off_scheduled") {
        return {
          routeTaken: "explicit_digital_assistant",
          cardId,
          ...(dispatchOutcome.dispatchId ? { dispatchId: dispatchOutcome.dispatchId } : {}),
        };
      }
    }

    await this.pushOwnerEarpiece(cardId, envelope, subgraph, assessment, true);
    return { routeTaken: "whisper_earpiece", cardId };
  }

  private async pushOwnerEarpiece(
    cardId: string,
    envelope: Awaited<ReturnType<typeof sealInboundConciergeEvent>>,
    subgraph: ReturnType<typeof recallPeerIsolatedSubgraph>,
    assessment: Awaited<ReturnType<typeof assessConciergeInbound>>,
    allowQuickSend: boolean,
  ): Promise<void> {
    const textCard = renderWeixinEarpieceText(cardId, envelope, subgraph, assessment);
    const finalText = allowQuickSend
      ? textCard
      : textCard.replace(/⚡ 快捷拍板：[\s\S]*$/, "🔒 群聊保护生效：仅供您私下参阅，不支持一键群发。");

    const feishuCard =
      envelope.channel === "feishu"
        ? (renderFeishuEarpieceCard(cardId, envelope, subgraph, assessment) as unknown as Record<
            string,
            unknown
          >)
        : undefined;

    await this.config.transport.notifyOwner(envelope.channel, finalText, feishuCard);
  }
}
