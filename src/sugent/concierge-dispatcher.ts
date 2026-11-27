import type { SuspendedRoundStore } from "./receipt-protocol.js";
import type { ConciergeChannelKind } from "./concierge-envelope.js";
import {
  enforceOutboundGuardrails,
  type OutboundIdentityMode,
} from "./concierge-guardrails.js";

export interface OutboundChannelTransport {
  sendPeerDirectMessage(
    channel: ConciergeChannelKind,
    peerId: string,
    text: string,
  ): Promise<void>;
  notifyOwner(
    channel: ConciergeChannelKind,
    text: string,
    feishuCardPayload?: Record<string, unknown>,
  ): Promise<void>;
}

export interface SuspendedRoundRecord {
  cardId: string;
  peerId: string;
  prompt: string;
  riskLevel: "low" | "medium" | "high";
  createdAtMs: number;
}

export interface SuspendedRoundStorePort {
  suspendRound(record: SuspendedRoundRecord): void;
  resolveRound(cardId: string, resolution: string): void;
  getSuspendedRound(cardId: string): SuspendedRoundRecord | undefined;
}

export function createSuspendedStoreAdapter(
  _nativeStore: SuspendedRoundStore,
  hooks: SuspendedRoundStorePort,
): SuspendedRoundStorePort {
  return hooks;
}

export interface RegisteredEarpieceCard {
  cardId: string;
  channel: ConciergeChannelKind;
  chatType?: "direct" | "group" | undefined;
  peerId: string;
  peerDisplayName: string;
  summary?: string | undefined;
  briefDigest?: string | undefined;
  riskLevel?: "normal" | "group_locked" | "red_line" | undefined;
  matchedRedLines?: readonly string[] | undefined;
  createdAtMs?: number | undefined;
  allowApprovedGroupReply?: boolean | undefined;
  crossPeerCanaryTokens: readonly string[];
  draftA: { body: string; confirmHash: string };
  draftB: { body: string; confirmHash: string };
  pendingCustomEdit?: { body: string; confirmHash: string } | undefined;
}

export interface PublicEarpieceCardView {
  cardId: string;
  channel: ConciergeChannelKind;
  chatType: "direct" | "group";
  peerId: string;
  peerDisplayName: string;
  summary: string;
  briefDigest: string;
  riskLevel: "normal" | "group_locked" | "red_line";
  matchedRedLines: string[];
  createdAtMs: number;
  draftA: { body: string; confirmHash: string };
  draftB: { body: string; confirmHash: string };
  pendingCustomEdit?: { body: string; confirmHash: string } | undefined;
}

export interface PublicPendingDispatchView {
  dispatchId: string;
  cardId: string;
  channel: ConciergeChannelKind;
  peerId: string;
  peerDisplayName: string;
  finalBody: string;
  resolutionTag: string;
  scheduledAtMs: number;
  expiresAtMs: number;
  remainingMs: number;
}

export interface ConciergeAuditEntry {
  id: string;
  atMs: number;
  channel: ConciergeChannelKind;
  peerId: string;
  peerDisplayName: string;
  outcome: "delivered" | "canceled_in_cooling_window" | "ignored" | "rejected_guardrail";
  detail: string;
}

export interface ConciergeWorkbenchSnapshot {
  cards: PublicEarpieceCardView[];
  pendingDispatches: PublicPendingDispatchView[];
  auditFeed: ConciergeAuditEntry[];
}

export type OwnerConciergeCommand =
  | { kind: "send"; option: "A" | "B"; cardId: string; confirmHash: string }
  | { kind: "edit"; cardId: string; customBody: string }
  | { kind: "confirm"; cardId: string; confirmHash: string }
  | { kind: "ignore"; cardId: string }
  | { kind: "undo"; dispatchId: string };

export interface CommandExecutionOutcome {
  status:
    | "cooling_off_scheduled"
    | "pending_double_confirm"
    | "canceled_in_cooling_window"
    | "ignored"
    | "rejected_hash_mismatch"
    | "rejected_guardrail"
    | "not_found";
  dispatchId?: string;
  requiredConfirmHash?: string;
  reason?: string;
}

interface PendingDispatchTimer {
  dispatchId: string;
  cardId: string;
  channel: ConciergeChannelKind;
  peerId: string;
  peerDisplayName: string;
  finalBody: string;
  resolutionTag: string;
  scheduledAtMs: number;
  expiresAtMs: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface ConciergeDispatcherOptions {
  ownerDisplayName: string;
  coolingWindowMs?: number;
  transport: OutboundChannelTransport;
  suspendedStore: SuspendedRoundStorePort;
}

export function parseOwnerCommand(rawText: string): OwnerConciergeCommand | null {
  const trimmed = rawText.trim();
  const sendMatch = /^\/send\s+([AB])\s+([a-zA-Z0-9_-]+)\s+([a-f0-9]{8})$/i.exec(trimmed);
  if (sendMatch) {
    return {
      kind: "send",
      option: sendMatch[1]!.toUpperCase() as "A" | "B",
      cardId: sendMatch[2]!,
      confirmHash: sendMatch[3]!.toLowerCase(),
    };
  }

  const editMatch = /^\/edit\s+([a-zA-Z0-9_-]+)\s+([\s\S]+)$/i.exec(trimmed);
  if (editMatch) {
    return {
      kind: "edit",
      cardId: editMatch[1]!,
      customBody: editMatch[2]!.trim(),
    };
  }

  const confirmMatch = /^\/confirm\s+([a-zA-Z0-9_-]+)\s+([a-f0-9]{8})$/i.exec(trimmed);
  if (confirmMatch) {
    return {
      kind: "confirm",
      cardId: confirmMatch[1]!,
      confirmHash: confirmMatch[2]!.toLowerCase(),
    };
  }

  const ignoreMatch = /^\/ignore\s+([a-zA-Z0-9_-]+)$/i.exec(trimmed);
  if (ignoreMatch) {
    return { kind: "ignore", cardId: ignoreMatch[1]! };
  }

  const undoMatch = /^\/undo\s+([a-zA-Z0-9_-]+)$/i.exec(trimmed);
  if (undoMatch) {
    return { kind: "undo", dispatchId: undoMatch[1]! };
  }

  return null;
}

export class ConciergeDispatcher {
  private readonly ownerDisplayName: string;
  private readonly coolingWindowMs: number;
  private readonly transport: OutboundChannelTransport;
  private readonly suspendedStore: SuspendedRoundStorePort;
  private readonly cards = new Map<string, RegisteredEarpieceCard>();
  private readonly pendingDispatches = new Map<string, PendingDispatchTimer>();
  private readonly auditFeed: ConciergeAuditEntry[] = [];
  private dispatchSeq = 0;

  constructor(options: ConciergeDispatcherOptions) {
    this.ownerDisplayName = options.ownerDisplayName;
    this.coolingWindowMs = options.coolingWindowMs ?? 15_000;
    this.transport = options.transport;
    this.suspendedStore = options.suspendedStore;
  }

  private pushAudit(entry: Omit<ConciergeAuditEntry, "id" | "atMs">): void {
    this.auditFeed.unshift({
      id: `aud_${Date.now()}_${++this.dispatchSeq}`,
      atMs: Date.now(),
      ...entry,
    });
    if (this.auditFeed.length > 30) {
      this.auditFeed.length = 30;
    }
  }

  registerEarpieceCard(card: RegisteredEarpieceCard): void {
    this.cards.set(card.cardId, card);
  }

  getWorkbenchSnapshot(nowMs = Date.now()): ConciergeWorkbenchSnapshot {
    const coolingCardIds = new Set<string>();
    const pendingDispatches: PublicPendingDispatchView[] = [];
    for (const d of this.pendingDispatches.values()) {
      coolingCardIds.add(d.cardId);
      pendingDispatches.push({
        dispatchId: d.dispatchId,
        cardId: d.cardId,
        channel: d.channel,
        peerId: d.peerId,
        peerDisplayName: d.peerDisplayName,
        finalBody: d.finalBody,
        resolutionTag: d.resolutionTag,
        scheduledAtMs: d.scheduledAtMs,
        expiresAtMs: d.expiresAtMs,
        remainingMs: Math.max(0, d.expiresAtMs - nowMs),
      });
    }

    const cards: PublicEarpieceCardView[] = [];
    for (const c of this.cards.values()) {
      if (coolingCardIds.has(c.cardId)) continue;
      cards.push({
        cardId: c.cardId,
        channel: c.channel,
        chatType: c.chatType ?? "direct",
        peerId: c.peerId,
        peerDisplayName: c.peerDisplayName,
        summary: c.summary ?? "",
        briefDigest: c.briefDigest ?? "",
        riskLevel: c.riskLevel ?? "normal",
        matchedRedLines: c.matchedRedLines ? [...c.matchedRedLines] : [],
        createdAtMs: c.createdAtMs ?? nowMs,
        draftA: { ...c.draftA },
        draftB: { ...c.draftB },
        ...(c.pendingCustomEdit ? { pendingCustomEdit: { ...c.pendingCustomEdit } } : {}),
      });
    }
    cards.sort((a, b) => b.createdAtMs - a.createdAtMs);

    return {
      cards,
      pendingDispatches,
      auditFeed: [...this.auditFeed],
    };
  }

  async scheduleValidatedOutbound(params: {
    cardId: string;
    channel: ConciergeChannelKind;
    chatType?: "direct" | "group" | undefined;
    allowApprovedGroupReply?: boolean | undefined;
    peerId: string;
    peerDisplayName: string;
    mode: OutboundIdentityMode;
    body: string;
    crossPeerCanaryTokens: readonly string[];
    resolutionTag: string;
    bypassDoubleConfirm?: boolean;
  }): Promise<CommandExecutionOutcome> {
    const verdict = enforceOutboundGuardrails({
      mode: params.mode,
      chatType: params.chatType ?? "direct",
      peerId: params.peerId,
      ownerDisplayName: this.ownerDisplayName,
      body: params.body,
      crossPeerCanaryTokens: params.crossPeerCanaryTokens,
      ...(params.allowApprovedGroupReply ? { allowApprovedGroupReply: true } : {}),
    });

    if (!verdict.allowed) {
      this.pushAudit({
        channel: params.channel,
        peerId: params.peerId,
        peerDisplayName: params.peerDisplayName,
        outcome: "rejected_guardrail",
        detail: verdict.reason ?? "防社死护栏熔断拦截",
      });
      await this.transport.notifyOwner(
        params.channel,
        `🚨【防社死熔断拦截】发往 ${params.peerDisplayName} 的消息已被 ${verdict.violatedGuardrail} 阻断：${verdict.reason}`,
      );
      return {
        status: "rejected_guardrail",
        ...(verdict.reason ? { reason: verdict.reason } : {}),
      };
    }

    if (verdict.requiresDoubleConfirm && !params.bypassDoubleConfirm) {
      const existing = this.cards.get(params.cardId);
      if (existing) {
        existing.pendingCustomEdit = {
          body: verdict.finalBody,
          confirmHash: verdict.confirmHash,
        };
      }
      await this.transport.notifyOwner(
        params.channel,
        `⚠️【二次金额/承诺确认】检测到发往 ${params.peerDisplayName} 的消息包含金额数字，请核对无误后回复：\n/confirm ${params.cardId} ${verdict.confirmHash}`,
      );
      return {
        status: "pending_double_confirm",
        requiredConfirmHash: verdict.confirmHash,
      };
    }

    this.dispatchSeq += 1;
    const dispatchId = `dsp_${params.cardId}_${this.dispatchSeq}`;
    const sec = Math.round(this.coolingWindowMs / 1000);
    const scheduledAtMs = Date.now();
    const expiresAtMs = scheduledAtMs + this.coolingWindowMs;

    const timer = setTimeout(() => {
      void this.flushDispatch(dispatchId);
    }, this.coolingWindowMs);

    this.pendingDispatches.set(dispatchId, {
      dispatchId,
      cardId: params.cardId,
      channel: params.channel,
      peerId: params.peerId,
      peerDisplayName: params.peerDisplayName,
      finalBody: verdict.finalBody,
      resolutionTag: params.resolutionTag,
      scheduledAtMs,
      expiresAtMs,
      timer,
    });

    await this.transport.notifyOwner(
      params.channel,
      `⏳ 已排入 ${sec}s 冷静撤回窗 → 即将发往【${params.peerDisplayName}】。反悔请立即回复：/undo ${dispatchId}`,
    );

    return {
      status: "cooling_off_scheduled",
      dispatchId,
    };
  }

  private async flushDispatch(dispatchId: string): Promise<void> {
    const item = this.pendingDispatches.get(dispatchId);
    if (!item) {
      return;
    }
    this.pendingDispatches.delete(dispatchId);
    await this.transport.sendPeerDirectMessage(item.channel, item.peerId, item.finalBody);
    this.pushAudit({
      channel: item.channel,
      peerId: item.peerId,
      peerDisplayName: item.peerDisplayName,
      outcome: "delivered",
      detail: item.finalBody,
    });
    this.suspendedStore.resolveRound(item.cardId, item.resolutionTag);
    this.cards.delete(item.cardId);
  }

  async handleOwnerCommand(cmd: OwnerConciergeCommand): Promise<CommandExecutionOutcome> {
    if (cmd.kind === "undo") {
      const pending = this.pendingDispatches.get(cmd.dispatchId);
      if (!pending) {
        return { status: "not_found", reason: "Dispatch already sent or unknown ID" };
      }
      clearTimeout(pending.timer);
      this.pendingDispatches.delete(cmd.dispatchId);
      this.pushAudit({
        channel: pending.channel,
        peerId: pending.peerId,
        peerDisplayName: pending.peerDisplayName,
        outcome: "canceled_in_cooling_window",
        detail: `已在冷静窗零痕迹拦截：${pending.finalBody.slice(0, 60)}`,
      });
      await this.transport.notifyOwner(
        pending.channel,
        `✅ 已成功拦截发往【${pending.peerDisplayName}】的消息（客户侧零痕迹）。`,
      );
      return { status: "canceled_in_cooling_window", dispatchId: cmd.dispatchId };
    }

    const card = this.cards.get(cmd.cardId);
    if (!card) {
      return { status: "not_found", reason: `Unknown cardId: ${cmd.cardId}` };
    }

    if (cmd.kind === "ignore") {
      this.cards.delete(cmd.cardId);
      this.suspendedStore.resolveRound(cmd.cardId, "ignored_by_owner");
      this.pushAudit({
        channel: card.channel,
        peerId: card.peerId,
        peerDisplayName: card.peerDisplayName,
        outcome: "ignored",
        detail: card.summary ?? "已归档忽略",
      });
      return { status: "ignored" };
    }

    if (cmd.kind === "send") {
      const targetDraft = cmd.option === "A" ? card.draftA : card.draftB;
      if (targetDraft.confirmHash !== cmd.confirmHash) {
        return {
          status: "rejected_hash_mismatch",
          reason: "Confirm hash mismatch against registered draft",
        };
      }
      return this.scheduleValidatedOutbound({
        cardId: card.cardId,
        channel: card.channel,
        chatType: card.chatType,
        allowApprovedGroupReply: card.allowApprovedGroupReply,
        peerId: card.peerId,
        peerDisplayName: card.peerDisplayName,
        mode: "owner_approved_proxy",
        body: targetDraft.body,
        crossPeerCanaryTokens: card.crossPeerCanaryTokens,
        resolutionTag: `sent_option_${cmd.option}`,
        bypassDoubleConfirm: true,
      });
    }

    if (cmd.kind === "edit") {
      return this.scheduleValidatedOutbound({
        cardId: card.cardId,
        channel: card.channel,
        chatType: card.chatType,
        allowApprovedGroupReply: card.allowApprovedGroupReply,
        peerId: card.peerId,
        peerDisplayName: card.peerDisplayName,
        mode: "owner_approved_proxy",
        body: cmd.customBody,
        crossPeerCanaryTokens: card.crossPeerCanaryTokens,
        resolutionTag: "sent_custom_edit",
        bypassDoubleConfirm: false,
      });
    }

    if (!card.pendingCustomEdit || card.pendingCustomEdit.confirmHash !== cmd.confirmHash) {
      return {
        status: "rejected_hash_mismatch",
        reason: "Secondary confirm hash does not match pending custom edit",
      };
    }

    return this.scheduleValidatedOutbound({
      cardId: card.cardId,
      channel: card.channel,
      chatType: card.chatType,
      allowApprovedGroupReply: card.allowApprovedGroupReply,
      peerId: card.peerId,
      peerDisplayName: card.peerDisplayName,
      mode: "owner_approved_proxy",
      body: card.pendingCustomEdit.body,
      crossPeerCanaryTokens: card.crossPeerCanaryTokens,
      resolutionTag: "sent_double_confirmed_edit",
      bypassDoubleConfirm: true,
    });
  }
}
