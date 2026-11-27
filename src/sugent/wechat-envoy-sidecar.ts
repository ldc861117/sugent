import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sealExternalEvent } from "./security-envelope.js";

export type WeChatEnvoyDmPolicy = "allowlist" | "open" | "disabled";
export type WeChatEnvoyGroupPolicy = "allowlist" | "disabled";

export interface WeChatEnvoyConfig {
  enabled: boolean;
  baseUrl: string;
  apiToken: string;
  selfWxid: string;
  selfAliases: string[];
  dmPolicy: WeChatEnvoyDmPolicy;
  allowedDmPeerIds: string[];
  groupPolicy: WeChatEnvoyGroupPolicy;
  allowedGroupIds: string[];
  allowRemoteHttps: boolean;
}

export interface WeChatEnvoyInboundMessage {
  messageId: string;
  chatId: string;
  isGroup: boolean;
  senderId: string;
  senderName: string;
  text: string;
  timestampMs: number;
  fromSelf: boolean;
  mentionedIds: string[];
  rawPayload: Record<string, unknown>;
}

export interface WeChatEnvoySendInput {
  chatId: string;
  text: string;
  replyToMessageId?: string;
  mentions?: string[];
}

export type WeChatEnvoySkippedResult = {
  ok: false;
  skipped: true;
};

export type WeChatEnvoyErrorResult = {
  ok: false;
  skipped?: false;
  status?: number;
  rateLimited?: boolean;
  retryAfterMs?: number;
  error: string;
};

export type WeChatEnvoyStatusResult =
  | WeChatEnvoySkippedResult
  | WeChatEnvoyErrorResult
  | {
      ok: true;
      online: boolean;
      loggedIn: boolean;
      selfWxid?: string;
      selfName?: string;
      accounts?: unknown[];
      data: unknown;
    };

export type WeChatEnvoyLoginQrResult =
  | WeChatEnvoySkippedResult
  | WeChatEnvoyErrorResult
  | {
      ok: true;
      qrUrl?: string;
      qrImageBase64?: string;
      qrAscii?: string;
      data: unknown;
    };

export type WeChatEnvoyFetchUnreadResult =
  | WeChatEnvoySkippedResult
  | WeChatEnvoyErrorResult
  | {
      ok: true;
      messages: WeChatEnvoyInboundMessage[];
      nextCursor?: string;
      mode: "events" | "chats_fallback";
    };

export type WeChatEnvoySendResult =
  | WeChatEnvoySkippedResult
  | WeChatEnvoyErrorResult
  | {
      ok: true;
      messageId?: string;
      data: unknown;
    };

export interface WeChatEnvoyClientRuntimeOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  rateLimitMaxPerMinute?: number;
  rateLimitWindowMs?: number;
  nowFn?: () => number;
}

export type WeChatEnvoyClientInit = Partial<WeChatEnvoyConfig> & WeChatEnvoyClientRuntimeOptions;

export interface WeChatEnvoyClientLike {
  isConfigured(): boolean;
  fetchUnreadEvents(cursor?: string): Promise<WeChatEnvoyFetchUnreadResult>;
}

export type WeChatEnvoySealedEvent = ReturnType<typeof sealExternalEvent>;

export type WeChatEnvoyEnvelope = WeChatEnvoySealedEvent["envelope"] & {
  prompt: string;
};

export interface WeChatEnvoyActionableInboundEvent {
  message: WeChatEnvoyInboundMessage;
  envelope: WeChatEnvoyEnvelope;
  prompt: string;
  sealed: WeChatEnvoySealedEvent;
}

export type WeChatEnvoyDisposition =
  | "dropped_self"
  | "dropped_policy"
  | "routed_group_silent"
  | "routed_concierge"
  | "deduplicated";

export interface WeChatEnvoyRoutedDecision {
  messageId: string;
  chatId: string;
  disposition: WeChatEnvoyDisposition;
  envelopePath?: string;
}

export interface WeChatEnvoyPollCycleResult {
  ok: boolean;
  skipped?: boolean;
  fetchedCount: number;
  droppedSelf: number;
  droppedPolicy: number;
  routedGroupSilent: number;
  routedConcierge: number;
  deduplicated: number;
  decisions: WeChatEnvoyRoutedDecision[];
  nextCursor?: string;
  error?: string;
}

export interface WeChatEnvoyPersistedState {
  cursor?: string;
  processedMessageIds: string[];
  updatedAt: string;
}

export interface WeChatEnvoyPollerOptions {
  config: WeChatEnvoyConfig;
  client?: WeChatEnvoyClientLike;
  dataDir: string;
  workspaceDir?: string;
  pollIntervalMs?: number;
  maxProcessedIds?: number;
  sealEventFn?: typeof sealExternalEvent;
  onGroupSilentMessage?: (message: WeChatEnvoyInboundMessage) => Promise<void> | void;
  onActionableInbound?: (event: WeChatEnvoyActionableInboundEvent) => Promise<void> | void;
  onError?: (error: unknown) => void;
}

const HTTP_SCHEME = ["http", "://"].join("");
const DEFAULT_ENVOY_BASE_URL = `${HTTP_SCHEME}127.0.0.1:6174`;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RATE_LIMIT_MAX_PER_MINUTE = 6;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_MAX_PROCESSED_IDS = 500;

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const DOCKER_INTERNAL_ENVOY_ORIGINS = new Set([
  `${HTTP_SCHEME}agent-wechat:6174`,
  `${HTTP_SCHEME}agent-wechat-native:6174`,
]);

function parseBooleanFlag(raw: string | undefined, defaultValue = false): boolean {
  if (raw === undefined) return defaultValue;
  const norm = raw.trim().toLowerCase();
  if (!norm) return defaultValue;
  return norm === "1" || norm === "true";
}

function parseCommaList(raw: string | undefined, opts?: { stripLeadingAt?: boolean }): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    let cleaned = part.trim();
    if (opts?.stripLeadingAt) cleaned = cleaned.replace(/^@+/, "").trim();
    if (cleaned && !seen.has(cleaned)) {
      seen.add(cleaned);
      out.push(cleaned);
    }
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function normalizeTimestampMs(value: unknown, fallbackMs: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 100_000_000_000 ? Math.trunc(value * 1000) : Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const num = Number(value.trim());
    if (Number.isFinite(num) && num > 0) {
      return num < 100_000_000_000 ? Math.trunc(num * 1000) : Math.trunc(num);
    }
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return fallbackMs;
}

function extractMentionedIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    let id: string | undefined;
    if (typeof item === "string") id = item.trim();
    else {
      const rec = asRecord(item);
      if (rec) id = asNonEmptyString(rec.wxid ?? rec.id ?? rec.userId ?? rec.username);
    }
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function encodeChatPathSegment(chatId: string): string {
  return encodeURIComponent(chatId).replace(/%40/g, "@");
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function assertSafeEnvoyTransportUrl(rawUrl: string, allowRemoteHttps = false): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) throw new Error("WeChat Envoy sidecar URL must not be empty");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid WeChat Envoy sidecar URL: ${trimmed}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("WeChat Envoy sidecar URL must not embed credentials; pass token via SUGENT_WECHAT_ENVOY_TOKEN");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported WeChat Envoy protocol "${parsed.protocol}" (expected http: or https:)`);
  }
  const hostname = parsed.hostname.toLowerCase();
  const normalizedPathname = parsed.pathname.replace(/\/+$/, "");
  const normalizedUrl = `${parsed.origin}${normalizedPathname}`;
  const isLoopback = LOOPBACK_HOSTNAMES.has(hostname);
  const isDockerInternal = DOCKER_INTERNAL_ENVOY_ORIGINS.has(parsed.origin.toLowerCase());

  if (parsed.protocol === "http:") {
    if (!isLoopback && !isDockerInternal) {
      throw new Error(
        `Refusing cleartext HTTP WeChat Envoy URL "${normalizedUrl}": Bearer Token may only traverse loopback or internal Docker sidecar`,
      );
    }
    return normalizedUrl;
  }
  if (!isLoopback && !allowRemoteHttps) {
    throw new Error(
      `Remote HTTPS WeChat Envoy URL "${normalizedUrl}" is blocked unless SUGENT_WECHAT_ENVOY_ALLOW_REMOTE_HTTPS=true`,
    );
  }
  return normalizedUrl;
}

export function resolveWeChatEnvoyConfig(
  env: Record<string, string | undefined> = process.env,
): WeChatEnvoyConfig {
  const enabled = parseBooleanFlag(env.SUGENT_WECHAT_ENVOY_ENABLED, false);
  const allowRemoteHttps = parseBooleanFlag(env.SUGENT_WECHAT_ENVOY_ALLOW_REMOTE_HTTPS, false);
  const rawUrl = (env.SUGENT_WECHAT_ENVOY_URL ?? "").trim();
  const baseUrl = rawUrl ? assertSafeEnvoyTransportUrl(rawUrl, allowRemoteHttps) : DEFAULT_ENVOY_BASE_URL;

  const rawDm = (env.SUGENT_WECHAT_ENVOY_DM_POLICY ?? "").trim().toLowerCase();
  let dmPolicy: WeChatEnvoyDmPolicy = "allowlist";
  if (rawDm) {
    if (rawDm === "allowlist" || rawDm === "open" || rawDm === "disabled") dmPolicy = rawDm;
    else throw new Error(`Invalid SUGENT_WECHAT_ENVOY_DM_POLICY "${env.SUGENT_WECHAT_ENVOY_DM_POLICY}"`);
  }

  const rawGroup = (env.SUGENT_WECHAT_ENVOY_GROUP_POLICY ?? "").trim().toLowerCase();
  let groupPolicy: WeChatEnvoyGroupPolicy = "allowlist";
  if (rawGroup) {
    if (rawGroup === "allowlist" || rawGroup === "disabled") groupPolicy = rawGroup;
    else throw new Error(`Invalid SUGENT_WECHAT_ENVOY_GROUP_POLICY "${env.SUGENT_WECHAT_ENVOY_GROUP_POLICY}"`);
  }

  return {
    enabled,
    baseUrl,
    apiToken: (env.SUGENT_WECHAT_ENVOY_TOKEN ?? "").trim(),
    selfWxid: (env.SUGENT_WECHAT_ENVOY_SELF_WXID ?? "").trim(),
    selfAliases: parseCommaList(env.SUGENT_WECHAT_ENVOY_SELF_ALIASES, { stripLeadingAt: true }),
    dmPolicy,
    allowedDmPeerIds: parseCommaList(env.SUGENT_WECHAT_ENVOY_ALLOW_DMS),
    groupPolicy,
    allowedGroupIds: parseCommaList(env.SUGENT_WECHAT_ENVOY_ALLOW_GROUPS),
    allowRemoteHttps,
  };
}

function normalizeInboundRecord(
  rawItem: unknown,
  fallbackChatId: string | undefined,
  nowMs: number,
): WeChatEnvoyInboundMessage | null {
  const outer = asRecord(rawItem);
  if (!outer) return null;
  const inner = asRecord(outer.message ?? outer.payload ?? outer.data) ?? outer;
  const chatId =
    asNonEmptyString(
      inner.chatId ?? inner.chat_id ?? inner.roomId ?? inner.room_id ?? inner.talker ?? outer.chatId ?? fallbackChatId,
    ) ?? "";
  const messageId =
    asNonEmptyString(inner.messageId ?? inner.message_id ?? inner.msgId ?? inner.msg_id ?? inner.id ?? outer.id) ?? "";
  if (!chatId || !messageId) return null;

  const isGroup =
    typeof inner.isGroup === "boolean"
      ? inner.isGroup
      : typeof inner.is_group === "boolean"
        ? inner.is_group
        : chatId.endsWith("@chatroom");
  const senderId =
    asNonEmptyString(inner.senderId ?? inner.sender_id ?? inner.fromUser ?? inner.from_user ?? inner.sender) ??
    (isGroup ? "unknown_member" : chatId);
  const senderName =
    asNonEmptyString(
      inner.senderName ?? inner.sender_name ?? inner.displayName ?? inner.nickname ?? inner.pushName,
    ) ?? senderId;
  const text =
    asNonEmptyString(inner.text ?? inner.content ?? inner.body ?? inner.message) ?? "";
  const fromSelf = Boolean(inner.fromSelf ?? inner.from_self ?? inner.isSelf ?? inner.self);
  const mentionedIds = extractMentionedIds(
    inner.mentionedIds ?? inner.mentioned_ids ?? inner.mentions ?? inner.atUserList,
  );
  const timestampMs = normalizeTimestampMs(
    inner.timestampMs ?? inner.timestamp_ms ?? inner.timestamp ?? inner.createTime ?? outer.timestamp,
    nowMs,
  );

  return {
    messageId,
    chatId,
    isGroup,
    senderId,
    senderName,
    text,
    timestampMs,
    fromSelf,
    mentionedIds,
    rawPayload: inner,
  };
}

export class WeChatEnvoySidecarClient implements WeChatEnvoyClientLike {
  private readonly enabled: boolean;
  private readonly baseUrl: string;
  private readonly apiToken: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly rateLimitMaxPerMinute: number;
  private readonly rateLimitWindowMs: number;
  private readonly nowFn: () => number;
  private readonly sendWindows = new Map<string, number[]>();

  constructor(config: WeChatEnvoyClientInit = {}, runtimeOpts: WeChatEnvoyClientRuntimeOptions = {}) {
    this.enabled = Boolean(config.enabled);
    const allowRemoteHttps = Boolean(config.allowRemoteHttps);
    const rawUrl = (config.baseUrl ?? "").trim();
    this.baseUrl = rawUrl
      ? assertSafeEnvoyTransportUrl(rawUrl, allowRemoteHttps)
      : DEFAULT_ENVOY_BASE_URL;
    this.apiToken = (config.apiToken ?? "").trim();
    this.fetchFn = runtimeOpts.fetchFn ?? config.fetchFn ?? globalThis.fetch;
    this.timeoutMs = runtimeOpts.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.rateLimitMaxPerMinute = Math.max(
      1,
      Math.trunc(runtimeOpts.rateLimitMaxPerMinute ?? config.rateLimitMaxPerMinute ?? DEFAULT_RATE_LIMIT_MAX_PER_MINUTE),
    );
    this.rateLimitWindowMs = Math.max(
      1_000,
      Math.trunc(runtimeOpts.rateLimitWindowMs ?? config.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS),
    );
    this.nowFn = runtimeOpts.nowFn ?? config.nowFn ?? (() => Date.now());
  }

  isConfigured(): boolean {
    return Boolean(this.enabled && this.baseUrl && this.apiToken);
  }

  private async requestJson(
    method: "GET" | "POST",
    subpath: string,
    body?: Record<string, unknown>,
  ): Promise<{ ok: boolean; status: number; data?: unknown; error?: string }> {
    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${this.apiToken}`,
        accept: "application/json",
      };
      if (body !== undefined) headers["content-type"] = "application/json";
      const res = await this.fetchFn(`${this.baseUrl}${subpath}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await res.text();
      let parsed: unknown = {};
      if (text.trim()) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { rawText: text };
        }
      }
      if (!res.ok) {
        const rec = asRecord(parsed);
        const msg = asNonEmptyString(rec?.error ?? rec?.message) ?? `HTTP_${res.status}`;
        return { ok: false, status: res.status, data: parsed, error: msg };
      }
      return { ok: true, status: res.status, data: parsed };
    } catch (err) {
      return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async getStatus(): Promise<WeChatEnvoyStatusResult> {
    if (!this.isConfigured()) return { ok: false, skipped: true };
    let res = await this.requestJson("GET", "/api/status");
    if (!res.ok && res.status === 404) {
      res = await this.requestJson("GET", "/api/accounts");
    }
    if (!res.ok) {
      return {
        ok: false,
        ...(res.status ? { status: res.status } : {}),
        error: res.error ?? "STATUS_REQUEST_FAILED",
      };
    }
    const rec = asRecord(res.data);
    const accounts = Array.isArray(res.data)
      ? res.data
      : Array.isArray(rec?.accounts)
        ? rec.accounts
        : undefined;
    const primaryAcct = accounts && accounts.length > 0 ? asRecord(accounts[0]) : null;
    const selfWxid = asNonEmptyString(
      rec?.selfWxid ?? rec?.wxid ?? rec?.userId ?? primaryAcct?.wxid ?? primaryAcct?.id,
    );
    const selfName = asNonEmptyString(
      rec?.selfName ?? rec?.nickname ?? rec?.name ?? primaryAcct?.nickname ?? primaryAcct?.name,
    );
    const loggedIn =
      typeof rec?.loggedIn === "boolean"
        ? rec.loggedIn
        : typeof rec?.authenticated === "boolean"
          ? rec.authenticated
          : primaryAcct
            ? primaryAcct.online !== false && primaryAcct.loggedIn !== false
            : Boolean(selfWxid);
    return {
      ok: true,
      online: rec?.online !== false,
      loggedIn,
      ...(selfWxid ? { selfWxid } : {}),
      ...(selfName ? { selfName } : {}),
      ...(accounts ? { accounts } : {}),
      data: res.data,
    };
  }

  async getLoginQr(): Promise<WeChatEnvoyLoginQrResult> {
    if (!this.isConfigured()) return { ok: false, skipped: true };
    let res = await this.requestJson("POST", "/api/auth/login", {});
    if (!res.ok && (res.status === 404 || res.status === 405)) {
      res = await this.requestJson("GET", "/api/auth/qr");
    }
    if (!res.ok) {
      return {
        ok: false,
        ...(res.status ? { status: res.status } : {}),
        error: res.error ?? "LOGIN_QR_FAILED",
      };
    }
    const rec = asRecord(res.data);
    const qrUrl = asNonEmptyString(rec?.qrUrl ?? rec?.qrcodeUrl ?? rec?.url ?? rec?.qrcode);
    const qrImageBase64 = asNonEmptyString(rec?.qrImageBase64 ?? rec?.imageBase64 ?? rec?.pngBase64);
    const qrAscii = asNonEmptyString(rec?.qrAscii ?? rec?.ascii);
    return {
      ok: true,
      ...(qrUrl ? { qrUrl } : {}),
      ...(qrImageBase64 ? { qrImageBase64 } : {}),
      ...(qrAscii ? { qrAscii } : {}),
      data: res.data,
    };
  }

  async fetchUnreadEvents(cursor?: string): Promise<WeChatEnvoyFetchUnreadResult> {
    if (!this.isConfigured()) return { ok: false, skipped: true };
    const nowMs = this.nowFn();
    const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const eventsRes = await this.requestJson("GET", `/api/events${qs}`);
    if (eventsRes.ok) {
      const rec = asRecord(eventsRes.data);
      const rawList = Array.isArray(eventsRes.data)
        ? eventsRes.data
        : Array.isArray(rec?.events)
          ? rec.events
          : Array.isArray(rec?.messages)
            ? rec.messages
            : Array.isArray(rec?.items)
              ? rec.items
              : [];
      const messages = rawList
        .map((item) => normalizeInboundRecord(item, undefined, nowMs))
        .filter((item): item is WeChatEnvoyInboundMessage => item !== null);
      const nextCursor = asNonEmptyString(rec?.nextCursor ?? rec?.next_cursor ?? rec?.cursor);
      return {
        ok: true,
        messages,
        ...(nextCursor ? { nextCursor } : {}),
        mode: "events",
      };
    }

    if (eventsRes.status !== 404) {
      return {
        ok: false,
        ...(eventsRes.status ? { status: eventsRes.status } : {}),
        error: eventsRes.error ?? "FETCH_EVENTS_FAILED",
      };
    }

    const chatsRes = await this.requestJson("GET", "/api/chats");
    if (!chatsRes.ok) {
      return {
        ok: false,
        ...(chatsRes.status ? { status: chatsRes.status } : {}),
        error: chatsRes.error ?? "FETCH_CHATS_FAILED",
      };
    }
    const chatsRec = asRecord(chatsRes.data);
    const rawChats = Array.isArray(chatsRes.data)
      ? chatsRes.data
      : Array.isArray(chatsRec?.chats)
        ? chatsRec.chats
        : Array.isArray(chatsRec?.items)
          ? chatsRec.items
          : [];

    const messages: WeChatEnvoyInboundMessage[] = [];
    for (const chatEntry of rawChats) {
      const cRec = asRecord(chatEntry);
      if (!cRec) continue;
      const chatId = asNonEmptyString(cRec.chatId ?? cRec.chat_id ?? cRec.id ?? cRec.wxid);
      if (!chatId) continue;
      const unreadRaw = cRec.unreadCount ?? cRec.unread_count ?? cRec.unread;
      const hasUnread =
        typeof unreadRaw === "number"
          ? unreadRaw > 0
          : typeof unreadRaw === "boolean"
            ? unreadRaw
            : false;
      if (!hasUnread) continue;

      const msgRes = await this.requestJson("GET", `/api/messages/${encodeChatPathSegment(chatId)}`);
      if (!msgRes.ok) continue;
      const mRec = asRecord(msgRes.data);
      const rawMsgs = Array.isArray(msgRes.data)
        ? msgRes.data
        : Array.isArray(mRec?.messages)
          ? mRec.messages
          : Array.isArray(mRec?.items)
            ? mRec.items
            : [];
      for (const m of rawMsgs) {
        const norm = normalizeInboundRecord(m, chatId, nowMs);
        if (norm) messages.push(norm);
      }
    }

    return {
      ok: true,
      messages,
      ...(cursor ? { nextCursor: cursor } : {}),
      mode: "chats_fallback",
    };
  }

  async sendMessage(input: WeChatEnvoySendInput): Promise<WeChatEnvoySendResult> {
    if (!this.isConfigured()) return { ok: false, skipped: true };
    const chatId = String(input.chatId ?? "").trim();
    const text = String(input.text ?? "").trim();
    if (!chatId) return { ok: false, error: "EMPTY_CHAT_ID" };
    if (!text) return { ok: false, error: "EMPTY_MESSAGE_TEXT" };

    const now = this.nowFn();
    const cutoff = now - this.rateLimitWindowMs;
    const prevStamps = (this.sendWindows.get(chatId) ?? []).filter((t) => t > cutoff);
    if (prevStamps.length >= this.rateLimitMaxPerMinute) {
      const oldest = prevStamps[0] ?? now;
      const retryAfterMs = Math.max(1, oldest + this.rateLimitWindowMs - now);
      this.sendWindows.set(chatId, prevStamps);
      return {
        ok: false,
        rateLimited: true,
        retryAfterMs,
        error: `WECHAT_ENVOY_RATE_LIMITED: max ${this.rateLimitMaxPerMinute} outbound messages per minute for ${chatId}`,
      };
    }

    const payload: Record<string, unknown> = {
      chatId,
      message: text,
      text,
      ...(input.replyToMessageId ? { replyTo: input.replyToMessageId } : {}),
      ...(input.mentions?.length ? { mentions: [...input.mentions] } : {}),
    };
    const res = await this.requestJson("POST", "/api/messages/send", payload);
    if (!res.ok) {
      return {
        ok: false,
        ...(res.status ? { status: res.status } : {}),
        error: res.error ?? "SEND_MESSAGE_FAILED",
      };
    }

    prevStamps.push(now);
    this.sendWindows.set(chatId, prevStamps);
    const rec = asRecord(res.data);
    const messageId = asNonEmptyString(rec?.messageId ?? rec?.message_id ?? rec?.id);
    return {
      ok: true,
      ...(messageId ? { messageId } : {}),
      data: res.data,
    };
  }
}

function writeAtomicJson600(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, filePath);
}

function sanitizeEnvelopeToken(raw: string, prefix: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._:/#@+-]/g, "_").slice(0, 96);
  return cleaned.length >= 2 ? cleaned : `${prefix}_${crypto.randomBytes(4).toString("hex")}`;
}

export class WeChatEnvoyPoller {
  private config: WeChatEnvoyConfig;
  private readonly client: WeChatEnvoyClientLike;
  private readonly statePath: string;
  private readonly workspaceDir: string;
  private readonly pollIntervalMs: number;
  private readonly maxProcessedIds: number;
  private readonly sealEventFn: typeof sealExternalEvent;
  private readonly onGroupSilentMessage?: WeChatEnvoyPollerOptions["onGroupSilentMessage"];
  private readonly onActionableInbound?: WeChatEnvoyPollerOptions["onActionableInbound"];
  private readonly onError?: WeChatEnvoyPollerOptions["onError"];
  private cursor: string | undefined;
  private processedIds: string[] = [];
  private processedSet = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private inflightCycle: Promise<WeChatEnvoyPollCycleResult> | undefined;

  constructor(opts: WeChatEnvoyPollerOptions) {
    this.config = {
      ...opts.config,
      selfAliases: [...opts.config.selfAliases],
      allowedDmPeerIds: [...opts.config.allowedDmPeerIds],
      allowedGroupIds: [...opts.config.allowedGroupIds],
    };
    this.client = opts.client ?? new WeChatEnvoySidecarClient(this.config);
    this.statePath = path.join(opts.dataDir, "sugent-stewardship", "wechat-envoy-state.json");
    this.workspaceDir = opts.workspaceDir ?? path.join(opts.dataDir, "sugent-stewardship", "wechat-envoy-workspace");
    this.pollIntervalMs = Math.max(500, Math.trunc(opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
    this.maxProcessedIds = Math.max(20, Math.trunc(opts.maxProcessedIds ?? DEFAULT_MAX_PROCESSED_IDS));
    this.sealEventFn = opts.sealEventFn ?? sealExternalEvent;
    this.onGroupSilentMessage = opts.onGroupSilentMessage;
    this.onActionableInbound = opts.onActionableInbound;
    this.onError = opts.onError;
    this.loadState();
  }

  private loadState(): void {
    if (!fs.existsSync(this.statePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as Partial<WeChatEnvoyPersistedState>;
      if (typeof parsed.cursor === "string" && parsed.cursor.trim()) {
        this.cursor = parsed.cursor.trim();
      }
      if (Array.isArray(parsed.processedMessageIds)) {
        const trimmed = parsed.processedMessageIds
          .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
          .slice(-this.maxProcessedIds);
        this.processedIds = trimmed;
        this.processedSet = new Set(trimmed);
      }
    } catch {
      // ignore corrupted state and rebuild cleanly
    }
  }

  private persistState(): void {
    const state: WeChatEnvoyPersistedState = {
      ...(this.cursor ? { cursor: this.cursor } : {}),
      processedMessageIds: [...this.processedIds],
      updatedAt: new Date().toISOString(),
    };
    writeAtomicJson600(this.statePath, state);
  }

  private markProcessed(messageId: string): void {
    if (this.processedSet.has(messageId)) return;
    this.processedSet.add(messageId);
    this.processedIds.push(messageId);
    while (this.processedIds.length > this.maxProcessedIds) {
      const evicted = this.processedIds.shift();
      if (evicted) this.processedSet.delete(evicted);
    }
  }

  getConfig(): WeChatEnvoyConfig {
    return {
      ...this.config,
      selfAliases: [...this.config.selfAliases],
      allowedDmPeerIds: [...this.config.allowedDmPeerIds],
      allowedGroupIds: [...this.config.allowedGroupIds],
    };
  }

  updateConfig(patch: Partial<WeChatEnvoyConfig>): WeChatEnvoyConfig {
    if (patch.baseUrl !== undefined) {
      const allowHttps = patch.allowRemoteHttps ?? this.config.allowRemoteHttps;
      this.config.baseUrl = assertSafeEnvoyTransportUrl(patch.baseUrl, allowHttps);
    }
    if (patch.allowRemoteHttps !== undefined) this.config.allowRemoteHttps = Boolean(patch.allowRemoteHttps);
    if (patch.enabled !== undefined) this.config.enabled = Boolean(patch.enabled);
    if (patch.apiToken !== undefined) this.config.apiToken = patch.apiToken.trim();
    if (patch.selfWxid !== undefined) this.config.selfWxid = patch.selfWxid.trim();
    if (patch.selfAliases !== undefined) this.config.selfAliases = patch.selfAliases.map((s) => s.trim()).filter(Boolean);
    if (patch.dmPolicy !== undefined) this.config.dmPolicy = patch.dmPolicy;
    if (patch.allowedDmPeerIds !== undefined) {
      this.config.allowedDmPeerIds = patch.allowedDmPeerIds.map((s) => s.trim()).filter(Boolean);
    }
    if (patch.groupPolicy !== undefined) this.config.groupPolicy = patch.groupPolicy;
    if (patch.allowedGroupIds !== undefined) {
      this.config.allowedGroupIds = patch.allowedGroupIds.map((s) => s.trim()).filter(Boolean);
    }
    return this.getConfig();
  }

  isRunning(): boolean {
    return Boolean(this.timer);
  }

  private isMentioningSelf(msg: WeChatEnvoyInboundMessage): boolean {
    if (this.config.selfWxid && msg.mentionedIds.includes(this.config.selfWxid)) {
      return true;
    }
    for (const alias of this.config.selfAliases) {
      if (!alias) continue;
      const re = new RegExp(`(?<![A-Za-z0-9._%+-])@${escapeRegExp(alias)}(?![A-Za-z0-9_-])`, "i");
      if (re.test(msg.text)) return true;
    }
    return false;
  }

  async runCycleOnce(): Promise<WeChatEnvoyPollCycleResult> {
    if (this.inflightCycle) return this.inflightCycle;
    const exec = async (): Promise<WeChatEnvoyPollCycleResult> => {
      if (!this.config.enabled || !this.client.isConfigured()) {
        return {
          ok: false,
          skipped: true,
          fetchedCount: 0,
          droppedSelf: 0,
          droppedPolicy: 0,
          routedGroupSilent: 0,
          routedConcierge: 0,
          deduplicated: 0,
          decisions: [],
        };
      }

      const fetched = await this.client.fetchUnreadEvents(this.cursor);
      if (!fetched.ok) {
        if ("skipped" in fetched && fetched.skipped) {
          return {
            ok: false,
            skipped: true,
            fetchedCount: 0,
            droppedSelf: 0,
            droppedPolicy: 0,
            routedGroupSilent: 0,
            routedConcierge: 0,
            deduplicated: 0,
            decisions: [],
          };
        }
        const errMsg = "error" in fetched ? fetched.error : "FETCH_FAILED";
        this.onError?.(new Error(errMsg));
        return {
          ok: false,
          fetchedCount: 0,
          droppedSelf: 0,
          droppedPolicy: 0,
          routedGroupSilent: 0,
          routedConcierge: 0,
          deduplicated: 0,
          decisions: [],
          error: errMsg,
        };
      }

      let droppedSelf = 0;
      let droppedPolicy = 0;
      let routedGroupSilent = 0;
      let routedConcierge = 0;
      let deduplicated = 0;
      const decisions: WeChatEnvoyRoutedDecision[] = [];

      const allowedGroups = new Set(this.config.allowedGroupIds);
      const allowedDms = new Set(this.config.allowedDmPeerIds);

      for (const msg of fetched.messages) {
        if (this.processedSet.has(msg.messageId)) {
          deduplicated += 1;
          decisions.push({ messageId: msg.messageId, chatId: msg.chatId, disposition: "deduplicated" });
          continue;
        }
        this.markProcessed(msg.messageId);

        if (msg.fromSelf || (this.config.selfWxid && msg.senderId === this.config.selfWxid)) {
          droppedSelf += 1;
          decisions.push({ messageId: msg.messageId, chatId: msg.chatId, disposition: "dropped_self" });
          continue;
        }

        const isGroup = msg.isGroup || msg.chatId.endsWith("@chatroom");
        if (isGroup) {
          if (this.config.groupPolicy === "disabled" || !allowedGroups.has(msg.chatId)) {
            droppedPolicy += 1;
            decisions.push({ messageId: msg.messageId, chatId: msg.chatId, disposition: "dropped_policy" });
            continue;
          }
          if (!this.isMentioningSelf(msg)) {
            await this.onGroupSilentMessage?.(msg);
            routedGroupSilent += 1;
            decisions.push({ messageId: msg.messageId, chatId: msg.chatId, disposition: "routed_group_silent" });
            continue;
          }
          const sealed = this.sealEventFn({
            workspaceDir: this.workspaceDir,
            source: "wechat_envoy",
            eventType: "group_mention",
            eventId: sanitizeEnvelopeToken(msg.messageId, "wxenv_grp"),
            ref: sanitizeEnvelopeToken(msg.chatId, "room"),
            title: `WeChat Group Mention (${msg.senderName} in ${msg.chatId})`,
            body: msg.text,
            payload: msg.rawPayload,
            privilegedFieldMode: "strip",
          });
          const envelope: WeChatEnvoyEnvelope = { ...sealed.envelope, prompt: sealed.prompt };
          await this.onActionableInbound?.({ message: msg, envelope, prompt: sealed.prompt, sealed });
          routedConcierge += 1;
          decisions.push({
            messageId: msg.messageId,
            chatId: msg.chatId,
            disposition: "routed_concierge",
            envelopePath: sealed.envelope.absoluteFilePath,
          });
          continue;
        }

        if (
          this.config.dmPolicy === "disabled" ||
          (this.config.dmPolicy === "allowlist" && !allowedDms.has(msg.senderId) && !allowedDms.has(msg.chatId))
        ) {
          droppedPolicy += 1;
          decisions.push({ messageId: msg.messageId, chatId: msg.chatId, disposition: "dropped_policy" });
          continue;
        }

        const sealed = this.sealEventFn({
          workspaceDir: this.workspaceDir,
          source: "wechat_envoy",
          eventType: "direct_message",
          eventId: sanitizeEnvelopeToken(msg.messageId, "wxenv_dm"),
          ref: sanitizeEnvelopeToken(msg.senderId, "peer"),
          title: `WeChat Envoy DM (${msg.senderName})`,
          body: msg.text,
          payload: msg.rawPayload,
          privilegedFieldMode: "strip",
        });
        const envelope: WeChatEnvoyEnvelope = { ...sealed.envelope, prompt: sealed.prompt };
        await this.onActionableInbound?.({ message: msg, envelope, prompt: sealed.prompt, sealed });
        routedConcierge += 1;
        decisions.push({
          messageId: msg.messageId,
          chatId: msg.chatId,
          disposition: "routed_concierge",
          envelopePath: sealed.envelope.absoluteFilePath,
        });
      }

      if (fetched.nextCursor !== undefined) {
        this.cursor = fetched.nextCursor;
      }
      if (fetched.messages.length > 0 || fetched.nextCursor !== undefined) {
        this.persistState();
      }

      return {
        ok: true,
        fetchedCount: fetched.messages.length,
        droppedSelf,
        droppedPolicy,
        routedGroupSilent,
        routedConcierge,
        deduplicated,
        decisions,
        ...(this.cursor ? { nextCursor: this.cursor } : {}),
      };
    };

    this.inflightCycle = exec().finally(() => {
      this.inflightCycle = undefined;
    });
    return this.inflightCycle;
  }

  start(opts?: { keepAlive?: boolean }): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runCycleOnce().catch((err) => this.onError?.(err));
    }, this.pollIntervalMs);
    if (!opts?.keepAlive) {
      this.timer.unref();
    }
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.inflightCycle) {
      await this.inflightCycle.catch(() => undefined);
    }
  }
}
