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
  accountId?: string;
  selfWxid: string;
  selfAliases: string[];
  dmPolicy: WeChatEnvoyDmPolicy;
  allowedDmPeerIds: string[];
  groupPolicy: WeChatEnvoyGroupPolicy;
  allowedGroupIds: string[];
  allowRemoteHttps: boolean;
  liveMaxAgeMs?: number;
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
  origin?: string;
  recalled?: boolean;
  rawPayload: Record<string, unknown>;
}

export interface WeChatEnvoySendInput {
  chatId: string;
  text: string;
  replyToMessageId?: string;
  mentions?: string[];
  idempotencyKey?: string;
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
  needsReview?: boolean;
  idempotencyKey?: string;
  error: string;
};

export type WeChatEnvoyStatusResult =
  | WeChatEnvoySkippedResult
  | WeChatEnvoyErrorResult
  | {
      ok: true;
      online: boolean;
      loggedIn: boolean;
      serverId?: string;
      accountId?: string;
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
      serverId?: string;
      cursorResetOnServerChange?: boolean;
      ignoredStaleOrHistory?: number;
      mode: "v1_events" | "events" | "chats_fallback";
    };

export type WeChatEnvoySendResult =
  | WeChatEnvoySkippedResult
  | WeChatEnvoyErrorResult
  | {
      ok: true;
      messageId?: string;
      sendId?: string;
      idempotencyKey?: string;
      recoveredViaReceipt?: boolean;
      data: unknown;
    };

export interface WeChatEnvoyClientRuntimeOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  streamReadTimeoutMs?: number;
  liveMaxAgeMs?: number;
  rateLimitMaxPerMinute?: number;
  rateLimitWindowMs?: number;
  nowFn?: () => number;
}

export type WeChatEnvoyClientInit = Partial<WeChatEnvoyConfig> & WeChatEnvoyClientRuntimeOptions;

export interface WeChatEnvoyClientLike {
  isConfigured(): boolean;
  fetchUnreadEvents(cursor?: string, serverIdHint?: string): Promise<WeChatEnvoyFetchUnreadResult>;
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
  serverId?: string;
  cursorResetOnServerChange?: boolean;
  error?: string;
}

export interface WeChatEnvoyPersistedState {
  cursor?: string;
  serverId?: string;
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
const DEFAULT_STREAM_READ_TIMEOUT_MS = 500;
const DEFAULT_LIVE_MAX_AGE_MS = 6 * 60_000;
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

  const rawAccountId = (env.SUGENT_WECHAT_ENVOY_ACCOUNT_ID ?? "").trim();
  const rawLiveMaxSec = Number((env.SUGENT_WECHAT_ENVOY_LIVE_MAX_AGE_SEC ?? "").trim());
  const liveMaxAgeMs =
    Number.isFinite(rawLiveMaxSec) && rawLiveMaxSec > 0
      ? Math.trunc(rawLiveMaxSec * 1_000)
      : undefined;

  return {
    enabled,
    baseUrl,
    apiToken: (env.SUGENT_WECHAT_ENVOY_TOKEN ?? "").trim(),
    ...(rawAccountId ? { accountId: rawAccountId } : {}),
    selfWxid: (env.SUGENT_WECHAT_ENVOY_SELF_WXID ?? "").trim(),
    selfAliases: parseCommaList(env.SUGENT_WECHAT_ENVOY_SELF_ALIASES, { stripLeadingAt: true }),
    dmPolicy,
    allowedDmPeerIds: parseCommaList(env.SUGENT_WECHAT_ENVOY_ALLOW_DMS),
    groupPolicy,
    allowedGroupIds: parseCommaList(env.SUGENT_WECHAT_ENVOY_ALLOW_GROUPS),
    allowRemoteHttps,
    ...(liveMaxAgeMs ? { liveMaxAgeMs } : {}),
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
  const origin = asNonEmptyString(inner.origin ?? outer.origin);
  const recalled = Boolean(
    inner.recalled ?? inner.isRecalled ?? outer.recalled ?? outer.type === "message.recalled",
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
    ...(origin ? { origin } : {}),
    ...(recalled ? { recalled: true } : {}),
    rawPayload: inner,
  };
}

interface ParsedSseEventFrame {
  id?: string;
  event?: string;
  data: unknown;
}

function parseSseFrames(rawSse: string): ParsedSseEventFrame[] {
  const frames: ParsedSseEventFrame[] = [];
  const normalized = rawSse.replace(/\r\n/g, "\n");
  for (const block of normalized.split("\n\n")) {
    const lines = block.split("\n");
    let id: string | undefined;
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of lines) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const rawVal = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "id") id = rawVal.trim() || id;
      else if (field === "event") event = rawVal.trim() || event;
      else if (field === "data") dataLines.push(rawVal);
    }
    if (!id && !event && dataLines.length === 0) continue;
    const joined = dataLines.join("\n").trim();
    let parsed: unknown = {};
    if (joined) {
      try {
        parsed = JSON.parse(joined);
      } catch {
        parsed = { rawText: joined };
      }
    }
    frames.push({ ...(id ? { id } : {}), ...(event ? { event } : {}), data: parsed });
  }
  return frames;
}

export class WeChatEnvoySidecarClient implements WeChatEnvoyClientLike {
  private readonly enabled: boolean;
  private readonly baseUrl: string;
  private readonly apiToken: string;
  private cachedAccountId: string;
  private cachedServerId: string | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly streamReadTimeoutMs: number;
  private readonly liveMaxAgeMs: number;
  private readonly rateLimitMaxPerMinute: number;
  private readonly rateLimitWindowMs: number;
  private readonly nowFn: () => number;
  private readonly sendWindows = new Map<string, number[]>();

  constructor(config: WeChatEnvoyClientInit = {}, runtimeOpts: WeChatEnvoyClientRuntimeOptions = {}) {
    this.enabled = Boolean(config.enabled);
    const allowRemoteHttps = Boolean(config.allowRemoteHttps);
    const rawUrl = (config.baseUrl ?? "").trim().replace(/\/v1$/i, "");
    this.baseUrl = rawUrl
      ? assertSafeEnvoyTransportUrl(rawUrl, allowRemoteHttps)
      : DEFAULT_ENVOY_BASE_URL;
    this.apiToken = (config.apiToken ?? "").trim();
    this.cachedAccountId = (config.accountId ?? "").trim();
    this.fetchFn = runtimeOpts.fetchFn ?? config.fetchFn ?? globalThis.fetch;
    this.timeoutMs = runtimeOpts.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.streamReadTimeoutMs =
      runtimeOpts.streamReadTimeoutMs ?? config.streamReadTimeoutMs ?? DEFAULT_STREAM_READ_TIMEOUT_MS;
    this.liveMaxAgeMs =
      runtimeOpts.liveMaxAgeMs ?? config.liveMaxAgeMs ?? DEFAULT_LIVE_MAX_AGE_MS;
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
    extraHeaders?: Record<string, string>,
    customTimeoutMs?: number,
  ): Promise<{ ok: boolean; status: number; contentType?: string; rawText?: string; data?: unknown; error?: string }> {
    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${this.apiToken}`,
        accept: "application/json",
        ...extraHeaders,
      };
      if (body !== undefined) headers["content-type"] = "application/json";
      const res = await this.fetchFn(`${this.baseUrl}${subpath}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(customTimeoutMs ?? this.timeoutMs),
      });
      const contentType = res.headers?.get("content-type") ?? "";
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
        return { ok: false, status: res.status, contentType, rawText: text, data: parsed, error: msg };
      }
      return { ok: true, status: res.status, contentType, rawText: text, data: parsed };
    } catch (err) {
      return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private extractAccountsList(data: unknown): Record<string, unknown>[] | undefined {
    const rec = asRecord(data);
    const rawArr = Array.isArray(data)
      ? data
      : Array.isArray(rec?.accounts)
        ? rec.accounts
        : Array.isArray(rec?.items)
          ? rec.items
          : undefined;
    if (!rawArr) return undefined;
    return rawArr.map((x) => asRecord(x)).filter((x): x is Record<string, unknown> => x !== null);
  }

  async getStatus(): Promise<WeChatEnvoyStatusResult> {
    if (!this.isConfigured()) return { ok: false, skipped: true };

    // 1. Prefer agent-wechat-native /v1/status + /v1/accounts when available
    const v1Res = await this.requestJson("GET", "/v1/status");
    const v1Rec = v1Res.ok ? asRecord(v1Res.data) : null;
    const v1ServerId = asNonEmptyString(v1Rec?.serverId ?? v1Rec?.server_id);
    if (v1Res.ok && (v1ServerId || Array.isArray(v1Rec?.accounts))) {
      if (v1ServerId) this.cachedServerId = v1ServerId;
      let accounts = this.extractAccountsList(v1Res.data);
      if (!accounts) {
        const acctsRes = await this.requestJson("GET", "/v1/accounts");
        if (acctsRes.ok) accounts = this.extractAccountsList(acctsRes.data);
      }
      const primaryAcct = accounts && accounts.length > 0 ? accounts[0] : null;
      const accountId =
        this.cachedAccountId ||
        asNonEmptyString(primaryAcct?.accountId ?? primaryAcct?.account_id ?? primaryAcct?.id);
      if (accountId && !this.cachedAccountId) this.cachedAccountId = accountId;
      const selfWxid = asNonEmptyString(
        v1Rec?.selfWxid ?? v1Rec?.wxid ?? primaryAcct?.wxid ?? primaryAcct?.username,
      );
      const selfName = asNonEmptyString(
        v1Rec?.selfName ?? v1Rec?.nickname ?? primaryAcct?.nickname ?? primaryAcct?.alias ?? primaryAcct?.name,
      );
      const loggedIn =
        typeof v1Rec?.loggedIn === "boolean"
          ? v1Rec.loggedIn
          : primaryAcct
            ? primaryAcct.online !== false && primaryAcct.loggedIn !== false && primaryAcct.state !== "logged_out"
            : Boolean(selfWxid);
      return {
        ok: true,
        online: v1Rec?.online !== false,
        loggedIn,
        ...(v1ServerId ? { serverId: v1ServerId } : {}),
        ...(accountId ? { accountId } : {}),
        ...(selfWxid ? { selfWxid } : {}),
        ...(selfName ? { selfName } : {}),
        ...(accounts ? { accounts } : {}),
        data: v1Res.data,
      };
    }

    // 2. Fallback to generic /api/status or /api/accounts
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
    let res = this.cachedAccountId
      ? await this.requestJson("POST", `/v1/accounts/${encodeURIComponent(this.cachedAccountId)}/login`, {})
      : await this.requestJson("POST", "/api/auth/login", {});
    if (!res.ok && (res.status === 404 || res.status === 405)) {
      res = await this.requestJson("POST", "/api/auth/login", {});
    }
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

  private isFreshLiveV1Message(msg: WeChatEnvoyInboundMessage, nowMs: number): boolean {
    if (msg.recalled) return false;
    if (msg.origin !== undefined && msg.origin !== "live") {
      return false;
    }
    if (msg.origin === "live") {
      const skewAllowanceMs = 60_000;
      const ageMs = nowMs - msg.timestampMs;
      if (ageMs > this.liveMaxAgeMs || ageMs < -skewAllowanceMs) {
        return false;
      }
    }
    return true;
  }

  async fetchUnreadEvents(cursor?: string, serverIdHint?: string): Promise<WeChatEnvoyFetchUnreadResult> {
    if (!this.isConfigured()) return { ok: false, skipped: true };
    const nowMs = this.nowFn();

    // 1. Check /v1/status for Native serverId & server recreation guard
    const v1Status = await this.requestJson("GET", "/v1/status");
    const v1StatusRec = v1Status.ok ? asRecord(v1Status.data) : null;
    const liveServerId = asNonEmptyString(v1StatusRec?.serverId ?? v1StatusRec?.server_id);
    if (liveServerId) {
      this.cachedServerId = liveServerId;
      const prevServerId = serverIdHint?.trim();
      if (prevServerId && prevServerId !== liveServerId) {
        return {
          ok: true,
          messages: [],
          serverId: liveServerId,
          cursorResetOnServerChange: true,
          mode: "v1_events",
        };
      }
    }

    // 2. If Native /v1 is detected (or /v1/events/stream returns SSE/v1 payload), consume /v1/events/stream
    if (liveServerId || this.cachedAccountId) {
      const qs = cursor ? `?after=${encodeURIComponent(cursor)}` : "";
      const streamHeaders: Record<string, string> = {
        accept: "text/event-stream, application/json",
        ...(cursor ? { "last-event-id": cursor } : {}),
      };
      const streamRes = await this.requestJson(
        "GET",
        `/v1/events/stream${qs}`,
        undefined,
        streamHeaders,
        this.streamReadTimeoutMs,
      );
      if (streamRes.status === 410) {
        return {
          ok: false,
          status: 410,
          error: "WECHAT_ENVOY_CURSOR_EXPIRED_410: Native event cursor expired; inspect sidecar event retention",
        };
      }
      if (streamRes.ok) {
        const rawText = streamRes.rawText ?? "";
        const isSse =
          (streamRes.contentType ?? "").includes("text/event-stream") ||
          /(?:^|\n)(?:event|data|id):/.test(rawText);
        const recalledIds = new Set<string>();
        const candidateItems: unknown[] = [];
        let nextCursor = cursor;

        if (isSse) {
          for (const frame of parseSseFrames(rawText)) {
            if (frame.id) nextCursor = frame.id;
            const dRec = asRecord(frame.data);
            const evType = frame.event ?? asNonEmptyString(dRec?.type ?? dRec?.event) ?? "";
            if (evType === "message.recalled" || dRec?.recalled === true) {
              const rId = asNonEmptyString(dRec?.messageId ?? dRec?.message_id ?? dRec?.id);
              if (rId) recalledIds.add(rId);
              continue;
            }
            if (!evType || evType === "message.committed" || evType === "message") {
              candidateItems.push(frame.data);
            }
          }
        } else {
          const rec = asRecord(streamRes.data);
          const arr = Array.isArray(streamRes.data)
            ? streamRes.data
            : Array.isArray(rec?.events)
              ? rec.events
              : undefined;
          if (arr) {
            candidateItems.push(...arr);
            nextCursor = asNonEmptyString(rec?.nextCursor ?? rec?.next_cursor ?? rec?.cursor) ?? nextCursor;
          }
        }

        const messages: WeChatEnvoyInboundMessage[] = [];
        let ignoredStaleOrHistory = 0;

        for (const item of candidateItems) {
          const itemRec = asRecord(item);
          const refMsgId = asNonEmptyString(
            itemRec?.messageId ?? itemRec?.message_id ?? asRecord(itemRec?.message)?.id ?? itemRec?.id,
          );
          if (refMsgId && recalledIds.has(refMsgId)) {
            ignoredStaleOrHistory += 1;
            continue;
          }

          let norm = normalizeInboundRecord(item, undefined, nowMs);
          if ((!norm || !norm.text) && refMsgId) {
            const detailRes = await this.requestJson("GET", `/v1/messages/${encodeURIComponent(refMsgId)}`);
            if (detailRes.ok) {
              const detailRec = asRecord(detailRes.data);
              const merged = {
                ...(itemRec ?? {}),
                ...(detailRec ?? {}),
                origin: detailRec?.origin ?? itemRec?.origin,
              };
              norm = normalizeInboundRecord(merged, undefined, nowMs);
            }
          }
          if (!norm || !norm.text) continue;
          if (recalledIds.has(norm.messageId) || !this.isFreshLiveV1Message(norm, nowMs)) {
            ignoredStaleOrHistory += 1;
            continue;
          }
          messages.push(norm);
        }

        return {
          ok: true,
          messages,
          ...(nextCursor ? { nextCursor } : {}),
          ...(liveServerId ? { serverId: liveServerId } : {}),
          ...(ignoredStaleOrHistory > 0 ? { ignoredStaleOrHistory } : {}),
          mode: "v1_events",
        };
      }
      // Timeout with empty SSE stream during quiet period is normal (zero new events)
      if (streamRes.status === 0 && /timeout|aborted/i.test(streamRes.error ?? "")) {
        return {
          ok: true,
          messages: [],
          ...(cursor ? { nextCursor: cursor } : {}),
          ...(liveServerId ? { serverId: liveServerId } : {}),
          mode: "v1_events",
        };
      }
    }

    // 3. Fallback to /api/events or /api/chats
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

  private async resolveV1AccountId(): Promise<string | undefined> {
    if (this.cachedAccountId) return this.cachedAccountId;
    const acctsRes = await this.requestJson("GET", "/v1/accounts");
    if (!acctsRes.ok) return undefined;
    const list = this.extractAccountsList(acctsRes.data);
    if (!list || list.length === 0) return undefined;
    const id = asNonEmptyString(list[0]?.accountId ?? list[0]?.account_id ?? list[0]?.id);
    if (id) this.cachedAccountId = id;
    return id;
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

    const idempotencyKey = (input.idempotencyKey ?? "").trim() || crypto.randomUUID();
    const payload: Record<string, unknown> = {
      chatId,
      target: chatId,
      message: text,
      text,
      ...(input.replyToMessageId ? { replyTo: input.replyToMessageId } : {}),
      ...(input.mentions?.length ? { mentions: [...input.mentions] } : {}),
    };

    // 1. Prefer agent-wechat-native POST /v1/accounts/{accountId}/sends with Idempotency-Key & single-shot receipt recovery
    const v1AccountId =
      this.cachedAccountId || (this.cachedServerId ? await this.resolveV1AccountId() : undefined);
    if (v1AccountId) {
      const v1SendPath = `/v1/accounts/${encodeURIComponent(v1AccountId)}/sends`;
      const v1Res = await this.requestJson("POST", v1SendPath, payload, {
        "idempotency-key": idempotencyKey,
      });
      if (v1Res.ok) {
        const rec = asRecord(v1Res.data);
        const sendStatus = asNonEmptyString(rec?.status);
        if (sendStatus === "partial" || sendStatus === "needs_review") {
          return {
            ok: false,
            needsReview: true,
            idempotencyKey,
            error: `WECHAT_ENVOY_SEND_NEEDS_REVIEW: status=${sendStatus} (do not auto-resend)`,
          };
        }
        prevStamps.push(now);
        this.sendWindows.set(chatId, prevStamps);
        const messageId = asNonEmptyString(rec?.messageId ?? rec?.message_id ?? rec?.id);
        const sendId = asNonEmptyString(rec?.sendId ?? rec?.send_id ?? rec?.id);
        return {
          ok: true,
          ...(messageId ? { messageId } : {}),
          ...(sendId ? { sendId } : {}),
          idempotencyKey,
          data: v1Res.data,
        };
      }

      // Uncertain network timeout / 408 / 429 / 5xx -> inspect receipt by Idempotency-Key instead of blind resend
      if (v1Res.status === 0 || v1Res.status === 408 || v1Res.status === 429 || v1Res.status >= 500) {
        const receiptRes = await this.requestJson(
          "GET",
          `/v1/accounts/${encodeURIComponent(v1AccountId)}/sends/by-idempotency-key/${encodeURIComponent(idempotencyKey)}`,
        );
        if (receiptRes.ok) {
          const rRec = asRecord(receiptRes.data);
          const rStatus = asNonEmptyString(rRec?.status);
          if (rStatus === "accepted" || rStatus === "sent" || rStatus === "completed") {
            prevStamps.push(now);
            this.sendWindows.set(chatId, prevStamps);
            const messageId = asNonEmptyString(rRec?.messageId ?? rRec?.message_id ?? rRec?.id);
            const sendId = asNonEmptyString(rRec?.sendId ?? rRec?.send_id ?? rRec?.id);
            return {
              ok: true,
              ...(messageId ? { messageId } : {}),
              ...(sendId ? { sendId } : {}),
              idempotencyKey,
              recoveredViaReceipt: true,
              data: receiptRes.data,
            };
          }
          if (rStatus === "partial" || rStatus === "needs_review") {
            return {
              ok: false,
              needsReview: true,
              idempotencyKey,
              error: `WECHAT_ENVOY_SEND_NEEDS_REVIEW: receipt status=${rStatus}`,
            };
          }
        }
        return {
          ok: false,
          ...(v1Res.status ? { status: v1Res.status } : {}),
          idempotencyKey,
          error: v1Res.error ?? "V1_SEND_UNCERTAIN",
        };
      }

      if (v1Res.status !== 404) {
        return {
          ok: false,
          ...(v1Res.status ? { status: v1Res.status } : {}),
          idempotencyKey,
          error: v1Res.error ?? "V1_SEND_FAILED",
        };
      }
    }

    // 2. Fallback to generic /api/messages/send
    const res = await this.requestJson("POST", "/api/messages/send", payload, {
      "idempotency-key": idempotencyKey,
    });
    if (!res.ok) {
      return {
        ok: false,
        ...(res.status ? { status: res.status } : {}),
        idempotencyKey,
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
      idempotencyKey,
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
  private serverId: string | undefined;
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
      if (typeof parsed.serverId === "string" && parsed.serverId.trim()) {
        this.serverId = parsed.serverId.trim();
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
      ...(this.serverId ? { serverId: this.serverId } : {}),
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

      const fetched = await this.client.fetchUnreadEvents(this.cursor, this.serverId);
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

      if (fetched.cursorResetOnServerChange) {
        this.cursor = undefined;
        this.serverId = fetched.serverId;
        this.persistState();
        return {
          ok: true,
          fetchedCount: 0,
          droppedSelf: 0,
          droppedPolicy: 0,
          routedGroupSilent: 0,
          routedConcierge: 0,
          deduplicated: 0,
          decisions: [],
          ...(this.serverId ? { serverId: this.serverId } : {}),
          cursorResetOnServerChange: true,
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

      let serverChanged = false;
      if (fetched.serverId && fetched.serverId !== this.serverId) {
        this.serverId = fetched.serverId;
        serverChanged = true;
      }
      if (fetched.nextCursor !== undefined) {
        this.cursor = fetched.nextCursor;
      }
      if (fetched.messages.length > 0 || fetched.nextCursor !== undefined || serverChanged) {
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
        ...(this.serverId ? { serverId: this.serverId } : {}),
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
