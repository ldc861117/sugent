import type { StewardRouteMeta } from "./steward-llm-agent.js";
import type { StewardWorkbenchLike } from "./steward-conversation.js";
import type { CallerAccessDomain } from "./stewardship-ledger.js";
import type { DropzoneChannel } from "./universal-dropzone.js";

export interface OwnerInboundChannelEvent {
  botId?: string;
  account?: string;
  channel: string;
  peerId: string;
  isGroup: boolean;
  isOwnerPeer: boolean;
  text: string;
}

export interface OwnerStewardConverseOutput {
  ok: boolean;
  intent?: string;
  reply: string;
  modelUsed?: string;
  routeMeta?: StewardRouteMeta;
  workbench?: StewardWorkbenchLike;
}

export interface OwnerStewardPort {
  converse(input: {
    text: string;
    history?: Array<{ role: "user" | "assistant"; content: string }>;
    callerDomain?: CallerAccessDomain;
    channel?: DropzoneChannel;
  }): Promise<OwnerStewardConverseOutput>;
  retryLastTurnStronger?(callerDomain?: CallerAccessDomain): Promise<
    | {
        ok: true;
        intent: string;
        reply: string;
        modelUsed?: string;
        routeMeta?: StewardRouteMeta;
        workbench?: StewardWorkbenchLike;
      }
    | {
        ok: false;
        errorCode: string;
        workbench?: StewardWorkbenchLike;
      }
  >;
  approveOpsInbox?(approvalId?: string): Promise<{ ok: boolean; handled: boolean; reply?: string }>;
  completeCommitmentByRef?(refText: string): Promise<{ ok: boolean; handled: boolean; reply?: string }>;
  decideGroupScribeDigest?(input: {
    digestId: string;
    decision: "approve" | "dismiss";
  }): { ok: boolean; message: string };
  replyPublicConcierge?(input: {
    sessionId: string;
    action: "approve_reply" | "unlock" | "merge" | "decline" | "block";
    ownerReply?: string;
  }): Promise<{ ok: boolean; message: string }>;
  ingestForwardedWeixinChat?(input: {
    rawForwardedText: string;
  }): {
    briefing: {
      threeLineSummary: [string, string, string];
      copyableDrafts: { firmBoundary: string; collaborativeTradeoff: string };
    };
    recordedCommitments: Array<{ summary: string }>;
  };
  handleAirTokenShortcut?(text: string): Promise<{ handled: boolean; reply?: string }>;
}

export interface OwnerStewardRouteResult {
  handled: boolean;
  reply?: string;
  modelUsed?: string;
  routeMeta?: StewardRouteMeta;
}

const RETRY_STRONGER_RE = /^(?:\/retry-stronger|换更强模型重试|重试更强模型|用更强模型重答|换个强模型重来)$/i;
const OPS_OK_CMD_RE = /^(?:\/ok(?:\s+([a-zA-Z0-9._-]+))?|同意(?:\s+([a-zA-Z0-9._-]+))?)[\s。.！!~～]*$/i;
const DONE_CMD_RE = /^\/done\s+(.+?)\s*$/i;
const DONE_NL_RE = /^(?:已完成|办完了|搞定了|已办完)\s*[:：]?\s*(.+?)\s*[。！!~～]*$/;
const DONE_ROADMAP_NL_RE = /^([A-Za-z]{1,3}\d+(?:\.\d+)+)\s*(?:已?办完|已完成|搞定了|弄好了|养号完成)[了啦。！!~～\s]*$/;
const GROUP_DIGEST_CMD_RE = /^\/gdig\s+(ok|approve|no|dismiss)\s+([a-zA-Z0-9._-]+)\s*$/i;
const PUBLIC_CONCIERGE_CMD_RE = /^\/pub\s+([a-zA-Z0-9._-]+)\s+([\s\S]+)$/i;
const MAX_HISTORY_MESSAGES = 20; // 10 user+assistant turns

function normalizeDropzoneChannel(raw: string): DropzoneChannel {
  const clean = raw.trim().toLowerCase();
  if (clean === "weixin" || clean === "wechat") return "weixin";
  if (clean === "feishu" || clean === "lark") return "feishu";
  if (clean === "desktop_hotkey" || clean === "tray_drop") return clean;
  return "web_ui";
}

export class OwnerChannelStewardRouter {
  private readonly historyByPeer = new Map<string, Array<{ role: "user" | "assistant"; content: string }>>();
  private readonly tailsByPeer = new Map<string, Promise<void>>();

  constructor(
    private readonly opts: {
      steward: OwnerStewardPort;
      enabled?: () => boolean;
      maxTurns?: number;
      hydrateHistory?: (input: {
        channel: string;
        peerId: string;
        maxMessages: number;
      }) => Array<{ role: "user" | "assistant"; content: string }>;
    },
  ) {}

  private sessionKey(channel: string, peerId: string): string {
    return `${channel.trim().toLowerCase()}::${peerId.trim()}`;
  }

  private ensurePeerHistory(channel: string, peerId: string, maxMessages: number): Array<{ role: "user" | "assistant"; content: string }> {
    const key = this.sessionKey(channel, peerId);
    const cached = this.historyByPeer.get(key);
    if (cached !== undefined) return cached;
    const hydrated = this.opts.hydrateHistory
      ? this.opts.hydrateHistory({
          channel: channel.trim().toLowerCase(),
          peerId: peerId.trim(),
          maxMessages,
        }).slice(-maxMessages)
      : [];
    this.historyByPeer.set(key, hydrated);
    return hydrated;
  }

  clearSessionHistory(channel: string, peerId: string): void {
    this.historyByPeer.set(this.sessionKey(channel, peerId), []);
  }

  canIntercept(ev: Pick<OwnerInboundChannelEvent, "isGroup" | "isOwnerPeer" | "text">): boolean {
    if (this.opts.enabled && !this.opts.enabled()) return false;
    if (Boolean(ev.isGroup) || ev.isOwnerPeer !== true) return false;
    return Boolean(String(ev.text ?? "").trim());
  }

  async tryHandleInbound(ev: OwnerInboundChannelEvent): Promise<OwnerStewardRouteResult> {
    if (!this.canIntercept(ev)) return { handled: false };
    const text = String(ev.text ?? "").trim();
    const key = this.sessionKey(ev.channel, ev.peerId);
    const maxMessages = Math.max(2, (this.opts.maxTurns ?? 10) * 2 || MAX_HISTORY_MESSAGES);

    const priorTail = this.tailsByPeer.get(key) ?? Promise.resolve();
    let releaseTail!: () => void;
    const currentTail = new Promise<void>((r) => {
      releaseTail = r;
    });
    const nextChain = priorTail.then(() => currentTail);
    this.tailsByPeer.set(key, nextChain);

    await priorTail;
    try {
      if (this.opts.steward.handleAirTokenShortcut) {
        const atRes = await this.opts.steward.handleAirTokenShortcut(text);
        if (atRes.handled && atRes.reply) {
          return { handled: true, reply: atRes.reply };
        }
      }

      const gdigMatch = GROUP_DIGEST_CMD_RE.exec(text);
      if (gdigMatch && this.opts.steward.decideGroupScribeDigest) {
        const act = gdigMatch[1]!.toLowerCase();
        const digestId = gdigMatch[2]!.trim();
        try {
          const decided = this.opts.steward.decideGroupScribeDigest({
            digestId,
            decision: act === "ok" || act === "approve" ? "approve" : "dismiss",
          });
          return { handled: true, reply: decided.message };
        } catch (err) {
          return { handled: true, reply: `群纪要处理失败：${(err as Error).message}` };
        }
      }

      const pubMatch = PUBLIC_CONCIERGE_CMD_RE.exec(text);
      if (pubMatch && this.opts.steward.replyPublicConcierge) {
        const firstTok = pubMatch[1]!.trim();
        const restText = pubMatch[2]!.trim();
        const isDecline = /^(?:decline|ignore|block)$/i.test(firstTok);
        const sessionId = isDecline ? restText.split(/\s+/)[0] || "" : firstTok;
        const decided = await this.opts.steward.replyPublicConcierge(
          isDecline
            ? { sessionId, action: firstTok.toLowerCase() === "block" ? "block" : "decline" }
            : { sessionId, action: "approve_reply", ownerReply: restText },
        );
        return { handled: true, reply: decided.message };
      }

      const okMatch = OPS_OK_CMD_RE.exec(text);
      if (okMatch && this.opts.steward.approveOpsInbox) {
        const targetId = (okMatch[1] || okMatch[2] || "").trim().replace(/\.+$/, "") || undefined;
        const approved = await this.opts.steward.approveOpsInbox(targetId);
        if (approved.handled && approved.reply) {
          return { handled: true, reply: approved.reply };
        }
      }

      const doneMatch = DONE_CMD_RE.exec(text) || DONE_NL_RE.exec(text) || DONE_ROADMAP_NL_RE.exec(text);
      if (doneMatch && this.opts.steward.completeCommitmentByRef) {
        const refText = String(doneMatch[1] || "").trim();
        if (refText) {
          const closed = await this.opts.steward.completeCommitmentByRef(refText);
          if (closed.handled && closed.reply) {
            return { handled: true, reply: closed.reply };
          }
        }
      }

      if (RETRY_STRONGER_RE.test(text) && this.opts.steward.retryLastTurnStronger) {
        const retried = await this.opts.steward.retryLastTurnStronger("owner_private");
        if (!retried.ok || !retried.reply.trim()) return { handled: false };
        const hist = this.ensurePeerHistory(ev.channel, ev.peerId, maxMessages);
        if (hist.length >= 2 && hist[hist.length - 1]?.role === "assistant") {
          const replaced = [...hist.slice(0, -1), { role: "assistant" as const, content: retried.reply }].slice(-maxMessages);
          this.historyByPeer.set(key, replaced);
        }
        return {
          handled: true,
          reply: retried.reply,
          ...(retried.modelUsed ? { modelUsed: retried.modelUsed } : {}),
          ...(retried.routeMeta ? { routeMeta: retried.routeMeta } : {}),
        };
      }

      let preIngestedForward:
        | ReturnType<NonNullable<OwnerStewardPort["ingestForwardedWeixinChat"]>>
        | undefined;
      if (text.includes("[合并转发的聊天记录]") && this.opts.steward.ingestForwardedWeixinChat) {
        try {
          preIngestedForward = this.opts.steward.ingestForwardedWeixinChat({ rawForwardedText: text });
        } catch {
          // non-blocking pre-ingestion
        }
      }

      const prior = [...this.ensurePeerHistory(ev.channel, ev.peerId, maxMessages)];
      const channel = normalizeDropzoneChannel(ev.channel);
      const out = await this.opts.steward.converse({
        text,
        history: prior,
        callerDomain: "owner_private",
        channel,
      });

      if (!out.ok || !String(out.reply ?? "").trim()) {
        if (preIngestedForward) {
          const b = preIngestedForward.briefing;
          const fallbackReply = [
            "【转发记录 3 秒参谋简报】",
            ...b.threeLineSummary,
            `已归档待办：${preIngestedForward.recordedCommitments.length} 项`,
            `话术A（守底线）：${b.copyableDrafts.firmBoundary}`,
            `话术B（谈折中）：${b.copyableDrafts.collaborativeTradeoff}`,
          ].join("\n");
          return { handled: true, reply: fallbackReply };
        }
        return { handled: false };
      }

      const latest = this.ensurePeerHistory(ev.channel, ev.peerId, maxMessages);
      const nextHist = [...latest, { role: "user" as const, content: text }, { role: "assistant" as const, content: out.reply }].slice(
        -maxMessages,
      );
      this.historyByPeer.set(key, nextHist);

      return {
        handled: true,
        reply: out.reply,
        ...(out.modelUsed ? { modelUsed: out.modelUsed } : {}),
        ...(out.routeMeta ? { routeMeta: out.routeMeta } : {}),
      };
    } finally {
      releaseTail();
      if (this.tailsByPeer.get(key) === nextChain) {
        this.tailsByPeer.delete(key);
      }
    }
  }
}
