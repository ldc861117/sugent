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
}

export interface OwnerStewardRouteResult {
  handled: boolean;
  reply?: string;
  modelUsed?: string;
  routeMeta?: StewardRouteMeta;
}

const RETRY_STRONGER_RE = /^(?:\/retry-stronger|换更强模型重试|重试更强模型|用更强模型重答|换个强模型重来)$/i;
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
    },
  ) {}

  private sessionKey(channel: string, peerId: string): string {
    return `${channel.trim().toLowerCase()}::${peerId.trim()}`;
  }

  clearSessionHistory(channel: string, peerId: string): void {
    this.historyByPeer.delete(this.sessionKey(channel, peerId));
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
      if (RETRY_STRONGER_RE.test(text) && this.opts.steward.retryLastTurnStronger) {
        const retried = await this.opts.steward.retryLastTurnStronger("owner_private");
        if (!retried.ok || !retried.reply.trim()) return { handled: false };
        const hist = this.historyByPeer.get(key) ?? [];
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

      const prior = [...(this.historyByPeer.get(key) ?? [])];
      const channel = normalizeDropzoneChannel(ev.channel);
      const out = await this.opts.steward.converse({
        text,
        history: prior,
        callerDomain: "owner_private",
        channel,
      });

      if (!out.ok || !String(out.reply ?? "").trim()) {
        return { handled: false };
      }

      const latest = this.historyByPeer.get(key) ?? [];
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
