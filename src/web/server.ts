import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Duplex } from "node:stream";
import { createRequire } from "node:module";
import { appVersion, type App } from "../app.js";
import type { InboundEvent, OutboundOp, ReplySession } from "../core/types.js";
import { eventText, isMessenger, isPushChannel } from "../core/types.js";
import type { PlatformError } from "../channels/messenger/transport.js";
import { findAppRoot } from "../magpie/supervisor.js";
import { logFilePath, logger, readLogTail, registerSecret } from "../log.js";
import { diagnosticsReport, safeStatus, testAgent, testModel } from "../diagnostics.js";
import { ZOOMS, normalizeLowBalance, saveConfigFile } from "../config.js";
import { ApiError } from "../account/client.js";
import { OAuthError } from "../account/oauth.js";
import { normalizeLine } from "../modelflare.js";
import { SseReply } from "./sse-reply.js";
import { LiveTurns, type LiveTurn } from "./live.js";
import { botWorkspace, describeFile, resolveFile, runnable, sendFile } from "./files.js";
import { connectionFromPids } from "../agent/peer-guard.js";
import type { ApprovalRow, Message, Store } from "../store/db.js";
import { defaultLine } from "../agent/approvals.js";
import { normalizeSettings } from "../agent/settings.js";
import {
  getOverlayRepoDir,
  getSelfEvolutionUiArchiveNotice,
  inspectSelfEvolutionPlugins,
  isPackagedAsar,
  resolveOverlayUiFile,
} from "../sugent/self-evolution.js";
import { parseSugentBrokerClaims } from "../sugent/auth-broker-contract.js";
import { SEARCH_PROVIDERS, normalizeSearxUrl, type SearchProvider } from "../agent/search.js";
import { ConnectionError } from "../agent/accounts.js";
import { scopeLabel } from "../agent/memory.js";
import { pwshProbe, type PwshMode } from "../agent/pwsh.js";
import { ACCESS_CHANNELS, peerName, shortPeer, whoText, type AccessChannel } from "../core/access.js";
import type { AccessEntry, RuleMode } from "../store/db.js";
import { normalizeSchedule, type Schedule } from "../tasks/schedule.js";
import { exportFileName } from "../tasks/export.js";
import type { StageGroup } from "../tasks/stage.js";
import { GUIDE_STEPS, deriveGuide, isGuideStep, mergeGuide, normalizeGuide, type GuideState } from "../guide.js";
import { normalizeLang, requestLang, setLangPref, t, withLang, type LangPref, t as tr } from "../i18n/index.js";

const log = logger("web");
const require = createRequire(import.meta.url);
const LOOPBACK_HTTP = ["http", "://"].join("");

export interface WebServer {
  url: string;
  port: number;
  token: string;
  inject(pathname: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; text: string }>;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

function vendorFiles(): Record<string, string> {
  const resolve = (spec: string) => {
    try {
      return require.resolve(spec);
    } catch {
      return "";
    }
  };
  const preact = resolve("preact");
  const preactDir = preact ? path.dirname(path.dirname(preact)) : "";
  return {
    "preact.mjs": preactDir ? path.join(preactDir, "dist", "preact.mjs") : "",
    "hooks.mjs": preactDir ? path.join(preactDir, "hooks", "dist", "hooks.mjs") : "",
    "htm.mjs": (() => {
      const h = resolve("htm");
      return h ? path.join(path.dirname(h), "htm.mjs") : "";
    })(),
  };
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function readJson(req: http.IncomingMessage, maxBytes = 1_000_000): Promise<any> {
  const ct = String(req.headers["content-type"] || "");
  if (!ct.includes("application/json")) throw new HttpError(415, t("web.needJson"));
  let body = "";
  for await (const c of req) {
    body += c;
    if (body.length > maxBytes) throw new HttpError(413, t("web.bodyTooLarge"));
  }
  return body ? JSON.parse(body) : {};
}

const NOTION_CALLBACK = "/oauth/notion/callback";

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function sendMarkdown(res: http.ServerResponse, title: string, text: string): void {
  const name = exportFileName(title);
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "_");
  res.writeHead(200, {
    "content-type": "text/markdown; charset=utf-8",
    "cache-control": "no-store",
    "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
  });
  res.end(text);
}

function publicBot(b: NonNullable<ReturnType<App["store"]["getBot"]>>) {
  return {
    id: b.id,
    name: b.name,
    systemPrompt: b.systemPrompt,
    defaultModel: b.defaultModel,
    settings: b.settings,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
}

function publicMessage(m: Message) {
  return m.files ? { ...m, files: m.files.map((p) => describeFile(p)) } : m;
}

class CollectReply implements ReplySession {
  text = "";
  prompts: Array<{ kind: string; prompt: string; requestId?: string; code?: string }> = [];
  files: string[] = [];
  async apply(op: OutboundOp): Promise<void> {
    if (op.type === "file") this.files.push(op.name);
    if (op.type === "stream.finish" || op.type === "text") this.text += (this.text ? "\n" : "") + op.text;
    else if (op.type === "interactive") this.prompts.push({ kind: op.kind, prompt: op.prompt, requestId: op.requestId, code: op.code });
  }
}

function webEvent(botId: string, text: string): InboundEvent {
  return {
    id: crypto.randomUUID(),
    channel: "web",
    botId,
    conversation: { kind: "dm", id: "console" },
    sender: { id: "owner", name: "控制台" },
    parts: [{ type: "text", text }],
    replyHandle: {},
    receivedAt: Date.now(),
  };
}
const consoleConvId = (botId: string) => `${botId}:web:console`;

function publicApproval(r: ApprovalRow, store?: Store) {
  const { payload, result, ...rest } = r;
  let questions: unknown = undefined;
  if (r.kind === "question") {
    try {
      questions = JSON.parse(payload);
    } catch {
      questions = [];
    }
  }
  const taskTitle = r.taskId ? store?.getTask(r.taskId)?.title : undefined;
  const note = r.taskId && r.status === "pending" ? defaultLine(r) : undefined;
  return { ...rest, questions, ...(taskTitle ? { taskTitle } : {}), ...(note ? { note } : {}) };
}

function publicAccess(e: AccessEntry) {
  return {
    id: e.id,
    channel: e.channel,
    peer: shortPeer(e.peerId),
    who: whoText(e),
    status: e.status,
    source: e.source,
    code: e.code,
    text: e.text,
    requests: e.requests,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    decidedAt: e.decidedAt,
  };
}

async function accountCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError) throw new HttpError(e.status >= 400 && e.status < 500 ? e.status : 502, e.message);
    if (e instanceof OAuthError) throw new HttpError(502, e.message);
    throw e;
  }
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export async function startWebServer(app: App, opts: { port?: number; host?: string } = {}): Promise<WebServer> {
  const cfg = app.config;
  const host = opts.host ?? cfg.ui.host;
  const uiDir = process.env.SUGENT_UI_DIR?.trim() || path.join(findAppRoot(), "ui");
  const vendor = vendorFiles();
  let token = cfg.ui.token;
  if (!isLoopback(host) && !token) {
    const f = path.join(cfg.dataDir, "ui-token");
    token = fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim() : crypto.randomBytes(18).toString("base64url");
    fs.writeFileSync(f, token, { mode: 0o600 });
    log.warn(`UI 监听在非回环地址 ${host}，访问需带令牌：见 ${f}（打开 /?token=<令牌> 一次即可）`);
  }
  registerSecret(token);

  let boundPort = 0;
  const allowedHosts = () => new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`]);

  const live = new LiveTurns();
  type CompanionSignalRecord = {
    kind: string;
    at: number;
    state?: string;
    cue?: string;
    notice?: string;
    hash?: string;
    draftText?: string;
    source?: string;
  };
  const COMPANION_SIGNAL_KINDS = new Set(["main_state", "handoff", "studio_updated", "toggle_quiet"]);
  let lastCompanionSignal: CompanionSignalRecord | null = null;
  const emitCompanionSignal = (signal: CompanionSignalRecord): CompanionSignalRecord => {
    lastCompanionSignal = signal;
    app.desktop?.notifyCompanion?.({ ...signal });
    return signal;
  };
  function startLive(botId: string, text: string): LiveTurn {
    const convId = consoleConvId(botId);
    const last = app.store.getConversation(convId) ? (app.store.listMessages(convId, 1).at(-1)?.id ?? 0) : 0;
    return live.start(convId, botId, text, last);
  }
  app.runtime.registerReplier("*", "web", (conv) => {
    if (conv.id !== consoleConvId(conv.botId)) return undefined;
    const t = startLive(conv.botId, "");
    return { out: t, done: () => live.end(t, "done", { conversationId: conv.id }) };
  });

  async function runLive(t: LiveTurn, ev: InboundEvent, out: ReplySession = t): Promise<void> {
    let err: Error | undefined;
    await app.queue.run(`web:${t.botId}:console`, async () => {
      try {
        await app.runtime.handle(ev, out, { signal: t.abort.signal });
      } catch (e) {
        err = e as Error;
      }
    });
    if (err) {
      log.warn("web chat failed", { message: err.message.slice(0, 300) });
      live.end(t, "error", { message: err.message });
    } else live.end(t, "done", { conversationId: t.conversationId });
  }

  function stopConversation(convId: string): boolean {
    const n = live.stop(convId);
    return app.runtime.stop(convId) || n > 0;
  }
  function interceptWeb(ev: InboundEvent): { handled: boolean; ack?: string } {
    if (eventText(ev).trim().toLowerCase() === "/stop") live.stop(consoleConvId(ev.botId));
    return app.runtime.interceptReply(ev);
  }

  function authorized(req: http.IncomingMessage, url: URL, res: http.ServerResponse): boolean {
    const pids = app.agent.childPids();
    if (pids.length && connectionFromPids(req.socket.remotePort, req.socket.localPort, pids)) {
      log.warn("blocked request from agent sandbox", { path: url.pathname });
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("forbidden from agent sandbox");
      return false;
    }
    if (isLoopback(host) && !allowedHosts().has(String(req.headers.host))) {
      res.writeHead(421).end("bad host");
      return false;
    }
    if (url.pathname.startsWith("/amb/api/steward/edge/")) {
      const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
      const edgeHdr = String(req.headers["x-sugent-edge-token"] || "").trim();
      const candidate = bearer || edgeHdr;
      if (candidate && app.stewardService.edgeHub.verifyToken(candidate)) {
        return true;
      }
    }
    if (!token) return true;
    const cookie = String(req.headers.cookie || "");
    const ok = cookie.split(/;\s*/).includes(`amb_token=${token}`) || req.headers["x-amb-token"] === token;
    if (ok) return true;
    if (url.searchParams.get("token") === token) {
      url.searchParams.delete("token");
      const xfProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0]?.trim().toLowerCase();
      const secureAttr = xfProto === "https" ? "; Secure" : "";
      res.writeHead(302, {
        "set-cookie": `amb_token=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=34560000${secureAttr}`,
        "referrer-policy": "no-referrer",
        location: url.pathname + url.search,
      });
      res.end();
      return false;
    }
    res.writeHead(401, { "content-type": "text/plain; charset=utf-8" }).end(t("web.needToken"));
    return false;
  }

  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const p = url.pathname.slice("/amb/api".length);
    const m = req.method || "GET";
    const seg = p.split("/").filter(Boolean);
    if ((m === "POST" || m === "PUT" || m === "PATCH") && !/^application\/json\s*(;|$)/i.test(String(req.headers["content-type"] || "").trim())) {
      throw new HttpError(415, t("web.needJson"));
    }

    if (p === "/status" && m === "GET") {
      const mp = app.magpie;
      return send(res, 200, {
        version: appVersion(),
        dataDir: cfg.dataDir,
        username: app.username,
        desktop: !!app.desktop,
        platform: process.platform,
        gateway: mp ? { mode: "managed", state: mp.state, lastError: mp.lastError, restarts: mp.restarts } : { mode: "external", state: "external" },
        notices: app.recentNotices,
      });
    }
    if (p === "/models" && m === "GET") {
      try {
        return send(res, 200, { models: await app.runtime.listModels(true) });
      } catch (e) {
        return send(res, 200, { models: [], error: (e as Error).message });
      }
    }
    if (p === "/hot-reload/stream" && m === "GET") {
      app.hotReloadBus.attachSse(res);
      return;
    }
    // —— 多模型服务商管理接口（OpenAI / Anthropic / DeepSeek / Gemini / OpenRouter / Ollama / Cowork）——
    if (seg[0] === "providers") {
      if (seg.length === 1 && m === "GET") {
        return send(res, 200, app.providers.publicView());
      }
      if (seg.length === 2 && seg[1] === "sync-models" && m === "POST") {
        const b = await readJson(req);
        const results = await app.syncProviderModels(typeof b.providerId === "string" ? b.providerId : undefined, b.force !== false);
        return send(res, 200, {
          ok: true,
          results,
          ...app.providers.publicView(),
          adaptiveRouting: app.stewardService.getRoutingDashboard(),
          models: await app.runtime.listModels(true).catch(() => [] as string[]),
        });
      }
      if (seg.length === 2 && seg[1] === "diagnostics" && m === "POST") {
        const b = await readJson(req);
        const out = await app.p2Service.runDiagnostics({
          ...(typeof b.providerId === "string" ? { providerId: b.providerId } : {}),
          ...(typeof b.timeoutMs === "number" ? { timeoutMs: b.timeoutMs } : {}),
          ...(typeof b.probeCapabilities === "boolean" ? { probeCapabilities: b.probeCapabilities } : {}),
          claims: app.activeBrokerClaims(),
        });
        return send(res, 200, out);
      }
      if (seg.length === 2 && seg[1] === "cost-sandbox" && m === "POST") {
        const b = await readJson(req);
        const out = await app.p2Service.simulateCostSandbox({
          ...(typeof b.preset === "string" ? { preset: b.preset } : {}),
          ...(typeof b.activeDaysPerMonth === "number" ? { activeDaysPerMonth: b.activeDaysPerMonth } : {}),
          ...(typeof b.promptCacheHitRatio === "number" ? { promptCacheHitRatio: b.promptCacheHitRatio } : {}),
          ...(b.roleModels && typeof b.roleModels === "object" ? { roleModels: b.roleModels } : {}),
          claims: app.activeBrokerClaims(),
        });
        return send(res, 200, out);
      }
      if (seg.length === 3 && seg[1] === "gemini-web2api" && seg[2] === "probe" && m === "POST") {
        const b = await readJson(req);
        if (typeof b.apiKey === "string" && b.apiKey.trim()) registerSecret(b.apiKey.trim());
        const probe = await app.probeGeminiWeb2ApiProvider({
          ...(typeof b.baseUrl === "string" ? { baseUrl: b.baseUrl } : {}),
          ...(typeof b.apiKey === "string" ? { apiKey: b.apiKey } : {}),
          ...(typeof b.providerId === "string" ? { providerId: b.providerId } : {}),
        });
        return send(res, 200, probe);
      }
      if (seg.length === 1 && m === "POST") {
        const b = await readJson(req);
        const result = await app.upsertDecoupledProvider({
          ...(b.id ? { id: String(b.id) } : {}),
          ...(b.name ? { name: String(b.name) } : {}),
          ...(b.preset ? { preset: b.preset } : {}),
          ...(b.baseUrl !== undefined ? { baseUrl: String(b.baseUrl) } : {}),
          ...(b.apiKey !== undefined ? { apiKey: String(b.apiKey) } : {}),
          ...(b.enabled !== undefined ? { enabled: Boolean(b.enabled) } : {}),
          ...(Array.isArray(b.models) ? { models: b.models.map(String) } : {}),
          ...(b.defaultModel ? { defaultModel: String(b.defaultModel) } : {}),
          setDefault: b.setDefault !== undefined ? Boolean(b.setDefault) : true,
        });
        return send(res, 200, { ...app.providers.publicView(), provider: result.provider, models: result.models });
      }
      if (seg.length === 2 && seg[1] === "routing" && m === "PUT") {
        const b = await readJson(req);
        const out = await app.updateProviderRouting({
          ...(typeof b.unlockSubscriptions === "boolean" ? { unlockSubscriptions: b.unlockSubscriptions } : {}),
          ...(typeof b.defaultProviderId === "string" ? { defaultProviderId: b.defaultProviderId } : {}),
          ...(typeof b.defaultModel === "string" ? { defaultModel: b.defaultModel } : {}),
          ...(typeof b.assessor === "string" ? { assessor: b.assessor } : {}),
          ...(typeof b.executor === "string" ? { executor: b.executor } : {}),
          ...(typeof b.computerUse === "string" ? { computerUse: b.computerUse } : {}),
          ...(typeof b.steward === "string" ? { steward: b.steward } : {}),
          ...(b.routing && typeof b.routing === "object" ? { routing: b.routing } : {}),
        });
        return send(res, 200, out);
      }
      const provId = seg[1] ? decodeURIComponent(seg[1]) : "";
      if (!provId) throw new HttpError(404, "not found");
      if (seg.length === 3 && seg[2] === "default" && (m === "POST" || m === "PUT")) {
        if (!app.providers.getProvider(provId)) throw new HttpError(404, tr("web.recordNotFound"));
        return send(res, 200, await app.setDefaultDecoupledProvider(provId));
      }
      if (seg.length === 2 && (m === "PUT" || m === "PATCH")) {
        if (!app.providers.getProvider(provId)) throw new HttpError(404, tr("web.recordNotFound"));
        const b = await readJson(req);
        const result = await app.upsertDecoupledProvider({
          id: provId,
          ...(b.name !== undefined ? { name: String(b.name) } : {}),
          ...(b.preset !== undefined ? { preset: b.preset } : {}),
          ...(b.baseUrl !== undefined ? { baseUrl: String(b.baseUrl) } : {}),
          ...(b.apiKey !== undefined ? { apiKey: String(b.apiKey) } : {}),
          ...(b.enabled !== undefined ? { enabled: Boolean(b.enabled) } : {}),
          ...(Array.isArray(b.models) ? { models: b.models.map(String) } : {}),
          ...(b.defaultModel !== undefined ? { defaultModel: String(b.defaultModel) } : {}),
          ...(b.setDefault !== undefined || b.isDefault !== undefined ? { setDefault: Boolean(b.setDefault ?? b.isDefault) } : {}),
        });
        return send(res, 200, { ...app.providers.publicView(), provider: result.provider, models: result.models });
      }
      if (seg.length === 2 && m === "DELETE") {
        const ok = await app.removeDecoupledProvider(provId);
        if (!ok) throw new HttpError(404, tr("web.recordNotFound"));
        return send(res, 200, app.providers.publicView());
      }
      throw new HttpError(405, "method not allowed");
    }
    // —— 通用身份认证接口（默认 none 主权免登录模式；支持 Google OAuth 桌面端与企业标准 OIDC + PKCE）——
    if (seg[0] === "auth") {
      const auth = app.ensureSugentAuth();
      const loopbackOk = isLoopback(host);
      const sub = seg.slice(1).join("/");
      if ((sub === "" || sub === "status") && m === "GET") {
        return send(res, 200, { ...auth.status(loopbackOk), config: auth.getConfig() });
      }
      if (sub === "config" && m === "PUT") {
        const b = await readJson(req);
        if (typeof b.clientSecret === "string" && b.clientSecret.trim()) {
          registerSecret(b.clientSecret.trim());
        }
        const cfgNext = app.configureSugentAuth({
          ...(b.mode !== undefined ? { mode: b.mode } : {}),
          ...(b.issuer !== undefined ? { issuer: String(b.issuer) } : {}),
          ...(b.clientId !== undefined ? { clientId: String(b.clientId) } : {}),
          ...(typeof b.clientSecret === "string" ? { clientSecret: b.clientSecret } : {}),
          ...(typeof b.clearClientSecret === "boolean" ? { clearClientSecret: b.clearClientSecret } : {}),
          ...(Array.isArray(b.allowedEndpointOrigins) ? { allowedEndpointOrigins: b.allowedEndpointOrigins.map(String) } : {}),
          ...(Array.isArray(b.scopes) ? { scopes: b.scopes.map(String) } : {}),
          ...(b.provisioningMode !== undefined ? { provisioningMode: b.provisioningMode } : {}),
          ...(b.keyExchangeUrl !== undefined ? { keyExchangeUrl: String(b.keyExchangeUrl) } : {}),
        });
        return send(res, 200, { ...auth.status(loopbackOk), config: cfgNext });
      }
      if (sub === "login" && m === "POST") {
        if (!loopbackOk) throw new HttpError(409, t("web.noBrowserLogin"));
        try {
          const session = await auth.startLogin();
          app.desktop?.openExternal(session.authorizationUrl);
          return send(res, 200, {
            ...auth.status(loopbackOk),
            authUrl: session.authorizationUrl,
            loginUrl: session.authorizationUrl,
            opened: !!app.desktop,
          });
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
      }
      if (sub === "login/cancel" && m === "POST") {
        auth.cancelLogin();
        return send(res, 200, auth.status(loopbackOk));
      }
      if (sub === "broker-preset" && m === "POST") {
        const b = await readJson(req);
        const cfgNext = app.applySugentAuthBrokerPreset({
          ...(typeof b.brokerOrigin === "string" ? { brokerOrigin: b.brokerOrigin } : {}),
          ...(typeof b.idpHint === "string" ? { idpHint: b.idpHint } : {}),
        });
        return send(res, 200, { ...auth.status(loopbackOk), config: cfgNext });
      }
      if ((sub === "logout" && m === "POST") || (sub === "session" && m === "DELETE")) {
        const revoked = await auth.logout();
        return send(res, 200, { ...auth.status(loopbackOk), revoked });
      }
      throw new HttpError(404, "not found");
    }
    // —— P2 零知识端到端加密图谱同步接口（Pro / Team 权益门控 + 端侧 AES-256-GCM 密封）——
    if (seg[0] === "sync") {
      const sub = seg.slice(1).join("/");
      if ((sub === "" || sub === "status") && m === "GET") {
        return send(res, 200, app.p2Service.getSyncStatus(app.activeBrokerClaims()));
      }
      if ((sub === "push" || sub === "pull") && m === "POST") {
        const b = await readJson(req);
        let claims = app.activeBrokerClaims();
        if (b.claims) {
          try {
            claims = parseSugentBrokerClaims(b.claims);
          } catch (e) {
            throw new HttpError(400, (e as Error).message);
          }
        }
        if (!claims) {
          return send(res, 403, {
            ok: false,
            errorCode: "SYNC_PLAN_UPGRADE_REQUIRED",
            message: "请先登录 Sugent Pro / Team 账户以开启零知识跨端图谱同步。",
          });
        }
        const bearerToken = String(b.bearerToken ?? app.activeBrokerToken() ?? "").trim();
        const passphrase = String(b.passphrase ?? "");
        if (passphrase) registerSecret(passphrase);
        const out =
          sub === "push"
            ? await app.p2Service.pushSync({ claims, bearerToken, passphrase })
            : await app.p2Service.pullSync({ claims, bearerToken, passphrase });
        return send(res, out.statusCode, out.body);
      }
      throw new HttpError(404, "not found");
    }
    // —— P1 OPC 微信/飞书幕僚耳麦与明牌数字助理接口 ——
    if (seg[0] === "concierge") {
      const sub = seg.slice(1).join("/");
      if ((sub === "" || sub === "status") && m === "GET") {
        return send(res, 200, app.conciergeBridge.getStatus());
      }
      if (sub === "workbench" && m === "GET") {
        return send(res, 200, app.conciergeBridge.getWorkbench());
      }
      if (sub === "simulate" && m === "POST") {
        const b = await readJson(req);
        const kind = b.chatType === "group" ? "group" : "dm";
        const peerId = String(b.peerId || (kind === "group" ? "oc_sim_group" : "wx_sim_peer")).trim();
        const senderId = String(b.senderId || (kind === "group" ? "ou_sim_member" : peerId)).trim();
        const senderName = String(b.senderName || peerId).trim();
        const text = String(b.text || "").trim();
        if (!text) throw new HttpError(400, "empty simulation text");
        const simId = `sim_${Date.now()}_${crypto.randomBytes(2).toString("hex")}`;
        if (b.channel === "wechat_envoy") {
          const outcome = await app.conciergeBridge.ingestWeChatEnvoyEvent({
            message: {
              messageId: simId,
              chatId: peerId,
              isGroup: kind === "group",
              senderId,
              senderName,
              text,
              timestampMs: Date.now(),
            },
          });
          return send(res, 200, { ok: true, outcome, workbench: app.conciergeBridge.getWorkbench() });
        }
        const channel = b.channel === "feishu" ? "feishu" : "weixin";
        const ev: InboundEvent = {
          id: simId,
          channel,
          botId: "default",
          account: "default",
          conversation: { kind, id: peerId },
          sender: { id: senderId, name: senderName },
          parts: [{ type: "text", text }],
          replyHandle: {},
          receivedAt: Date.now(),
        };
        const outcome = await app.conciergeBridge.processInboundEvent(ev);
        return send(res, 200, { ok: true, outcome, workbench: app.conciergeBridge.getWorkbench() });
      }
      if (sub === "config" && m === "PUT") {
        const b = await readJson(req);
        return send(res, 200, app.conciergeBridge.updateConfig(b));
      }
      if (sub === "command" && m === "POST") {
        const b = await readJson(req);
        const outcome = await app.conciergeBridge.executeOwnerCommand(
          String(b.commandText ?? ""),
          b.channel === "feishu" ? "feishu" : b.channel === "wechat_envoy" ? "wechat_envoy" : "weixin",
        );
        return send(res, 200, { ok: true, outcome, workbench: app.conciergeBridge.getWorkbench() });
      }
      throw new HttpError(404, "not found");
    }
    // —— Sprint 1 & 2 贾维斯生命幕僚工作台与 Antigravity 多表面感知接口 ——
    if (seg[0] === "steward") {
      const sub = seg.slice(1).join("/");
      const qDomain = url.searchParams.get("domain");
      const domain = qDomain === "work_project" || qDomain === "cowork_shared" ? qDomain : "owner_private";
      if ((sub === "" || sub === "workbench") && m === "GET") {
        return send(res, 200, app.stewardService.getWorkbench(domain));
      }
      if (sub === "converse" && m === "POST") {
        const b = await readJson(req);
        const userText = typeof b?.text === "string" ? b.text.trim() : "";
        const turnDomain = b?.callerDomain === "work_project" || b?.callerDomain === "cowork_shared" ? b.callerDomain : domain;
        if (userText && turnDomain === "owner_private") {
          app.stewardService.chatRecall.recordDirectStewardTurn({
            channel: typeof b?.channel === "string" ? b.channel : "web_ui",
            role: "user",
            content: userText,
          });
        }
        const out = await app.stewardService.converse(b);
        if (out.ok && typeof out.reply === "string" && out.reply.trim() && turnDomain === "owner_private") {
          app.stewardService.chatRecall.recordDirectStewardTurn({
            channel: typeof b?.channel === "string" ? b.channel : "web_ui",
            role: "assistant",
            content: out.reply,
          });
        }
        return send(res, 200, out);
      }
      if (sub === "edge/pulse" && m === "POST") {
        const b = await readJson(req);
        const nodeId = typeof b?.nodeId === "string" ? b.nodeId.trim() : "";
        if (!nodeId) throw new HttpError(400, "nodeId is required");
        if (!Array.isArray(b?.projects)) throw new HttpError(400, "projects array is required");
        return send(res, 200, app.stewardService.ingestEdgeNodePulse({
          nodeId,
          ...(typeof b.platform === "string" ? { platform: b.platform } : {}),
          ...(typeof b.hostname === "string" ? { hostname: b.hostname } : {}),
          ...(typeof b.atIso === "string" ? { atIso: b.atIso } : {}),
          projects: b.projects,
        }));
      }
      if (sub === "edge/commands" && m === "GET") {
        const nodeId = String(url.searchParams.get("nodeId") ?? "").trim();
        if (!nodeId) throw new HttpError(400, "nodeId query parameter is required");
        return send(res, 200, { ok: true, commands: app.stewardService.edgeHub.pullPendingCommands(nodeId) });
      }
      if (seg[1] === "edge" && seg[2] === "commands" && seg[4] === "ack" && seg.length === 5 && m === "POST") {
        const cmdId = decodeURIComponent(seg[3] ?? "").trim();
        const b = await readJson(req);
        if (b?.status !== "accepted" && b?.status !== "completed" && b?.status !== "failed") {
          throw new HttpError(400, "status must be accepted, completed, or failed");
        }
        const ack = app.stewardService.edgeHub.ackCommand(cmdId, {
          nodeId: typeof b.nodeId === "string" ? b.nodeId.trim() : "",
          status: b.status,
          ...(typeof b.summary === "string" ? { summary: b.summary } : {}),
          ...(typeof b.conversationId === "string" ? { conversationId: b.conversationId } : {}),
        });
        if (!ack.ok) throw new HttpError(404, "edge command not found");
        if (ack.ownerNotifyText && !app.stewardService.getWorkbench("owner_private").quietHoursActive) {
          void app.pushToOwner(ack.ownerNotifyText).catch(() => false);
        }
        return send(res, 200, ack);
      }
      if (sub === "edge/snapshot" && m === "GET") {
        return send(res, 200, {
          ok: true,
          nodes: app.stewardService.edgeHub.listNodes(),
          snapshot: app.stewardService.getMergedOpsFleetSnapshot() ?? app.stewardService.edgeHub.toOpsStewardSnapshot(),
          recentCommands: app.stewardService.edgeHub.listCommands({ limit: 20 }),
        });
      }
      if (sub === "wechat-envoy/status" && m === "GET") {
        const live = url.searchParams.get("live") === "1" && app.stewardService.wechatEnvoyClient.isConfigured()
          ? await app.stewardService.wechatEnvoyClient.getStatus()
          : undefined;
        return send(res, 200, { ok: true, ...app.stewardService.getWeChatEnvoyOverview(), ...(live ? { sidecarStatus: live } : {}) });
      }
      if (sub === "wechat-envoy/poll" && m === "POST") {
        await readJson(req);
        return send(res, 200, { ok: true, cycle: await app.stewardService.pollWeChatEnvoyOnce() });
      }
      if (sub === "wechat-envoy/allowlist" && m === "POST") {
        const b = await readJson(req);
        return send(res, 200, { ok: true, ...app.stewardService.updateWeChatEnvoyAllowlist(b ?? {}) });
      }
      if (sub === "group-scribe/digests" && m === "GET") {
        const st = url.searchParams.get("status");
        const statusFilter = st === "pending_approval" || st === "approved" || st === "dismissed" ? st : undefined;
        return send(res, 200, {
          ok: true,
          outboundGroupMessagesSent: app.stewardService.groupScribe.outboundGroupMessagesSent,
          digests: app.stewardService.groupScribe.listDigests(statusFilter ? { status: statusFilter } : {}),
        });
      }
      if (sub === "group-scribe/distill" && m === "POST") {
        const b = await readJson(req);
        const groupId = typeof b?.groupId === "string" ? b.groupId.trim() : "";
        if (!groupId) throw new HttpError(400, "groupId is required");
        return send(res, 200, {
          ok: true,
          digest: await app.stewardService.distillGroupScribeDigest({
            groupId,
            ...(typeof b.groupName === "string" ? { groupName: b.groupName } : {}),
            ...(typeof b.projectKey === "string" ? { projectKey: b.projectKey } : {}),
            ...(Array.isArray(b.ownerAliases) ? { ownerAliases: b.ownerAliases.map(String) } : {}),
          }),
        });
      }
      if (sub === "group-scribe/decide" && m === "POST") {
        const b = await readJson(req);
        const digestId = typeof b?.digestId === "string" ? b.digestId.trim() : "";
        if (!digestId) throw new HttpError(400, "digestId is required");
        if (b?.decision !== "approve" && b?.decision !== "dismiss") {
          throw new HttpError(400, "decision must be approve or dismiss");
        }
        return send(res, 200, app.stewardService.decideGroupScribeDigest({ digestId, decision: b.decision }));
      }
      if (sub === "public-concierge/decide" && m === "POST") {
        const b = await readJson(req);
        const sessionId = typeof b?.sessionId === "string" ? b.sessionId.trim() : "";
        if (!sessionId) throw new HttpError(400, "sessionId is required");
        const validActions = new Set(["approve_reply", "unlock", "merge", "decline", "block"]);
        const action = typeof b?.action === "string" && validActions.has(b.action) ? b.action : "approve_reply";
        return send(
          res,
          200,
          await app.stewardService.replyPublicConcierge({
            sessionId,
            action,
            ...(typeof b.ownerReply === "string" ? { ownerReply: b.ownerReply } : {}),
            ...(typeof b.branchDraft === "string" ? { branchDraft: b.branchDraft } : {}),
          }),
        );
      }
      if (sub === "preferences" && m === "POST") {
        const b = await readJson(req);
        return send(res, 200, app.stewardService.setQuietHours(Boolean(b.quietHoursActive), b.callerDomain));
      }
      if (sub === "dropzone" && m === "POST") {
        return send(res, 200, await app.stewardService.submitDropzone(await readJson(req)));
      }
      if (sub === "trust" && m === "POST") {
        return send(res, 200, app.stewardService.mutateTrust(await readJson(req)));
      }
      if (sub === "goals" && m === "POST") {
        return send(res, 200, app.stewardService.mutateGoal(await readJson(req)));
      }
      if (sub === "commitments" && m === "POST") {
        return send(res, 200, app.stewardService.mutateCommitment(await readJson(req)));
      }
      if (sub === "cadence/scan" && m === "POST") {
        return send(res, 200, app.stewardService.scanCadence(await readJson(req)));
      }
      if (sub === "cadence/morning" && m === "POST") {
        return send(res, 200, app.stewardService.drainMorning(await readJson(req)));
      }
      if (sub === "antigravity/tier" && m === "POST") {
        return send(res, 200, app.stewardService.setProjectTier(await readJson(req)));
      }
      if (sub === "antigravity/viewed" && m === "POST") {
        return send(res, 200, app.stewardService.markSessionViewed(await readJson(req)));
      }
      if (sub === "antigravity/comprehend" && m === "POST") {
        return send(res, 200, await app.stewardService.comprehendSession(await readJson(req)));
      }
      if (sub === "antigravity/dispatch" && m === "POST") {
        return send(res, 200, await app.stewardService.dispatchAntigravity(await readJson(req)));
      }
      if (sub === "mcp" && m === "POST") {
        return send(res, 200, await app.stewardService.mcpServer.handleJsonRpc(await readJson(req)));
      }
      if (sub === "repos" && m === "POST") {
        const b = await readJson(req);
        if (b.action === "bind_self") return send(res, 200, app.stewardService.bindSelfRepo(b, domain));
        if (b.action === "remove") return send(res, 200, app.stewardService.removeRepoBinding(String(b.bindingId ?? ""), domain));
        return send(res, 200, app.stewardService.upsertRepoBinding(b, domain));
      }
      if (sub === "vibe/start" && m === "POST") {
        return send(res, 200, await app.stewardService.startVibeTask(await readJson(req)));
      }
      if (sub === "vibe/decide" && m === "POST") {
        return send(res, 200, await app.stewardService.decideVibeTask(await readJson(req)));
      }
      if (sub === "vibe/advance" && m === "POST") {
        return send(res, 200, await app.stewardService.advanceVibePipeline(await readJson(req)));
      }
      if (sub === "capabilities" && m === "GET") {
        return send(res, 200, app.stewardService.getCapabilitySnapshot());
      }
      if (sub === "skill-candidates" && m === "GET") {
        const th = Number(url.searchParams.get("threshold") ?? "3");
        return send(res, 200, app.stewardService.listSkillCandidates(Number.isFinite(th) && th > 0 ? th : 3));
      }
      if (sub === "skill-candidates/decide" && m === "POST") {
        const b = await readJson(req);
        if (!b || typeof b !== "object" || Array.isArray(b)) {
          throw new HttpError(400, "body must be a JSON object");
        }
        if (b.decision !== "approve" && b.decision !== "reject") {
          throw new HttpError(400, "decision must be approve or reject");
        }
        if (typeof b.nodeId !== "string" || !b.nodeId.trim()) {
          throw new HttpError(400, "nodeId must be a non-empty string");
        }
        if (
          b.maxActiveSkills !== undefined &&
          (!Number.isInteger(b.maxActiveSkills) || b.maxActiveSkills <= 0)
        ) {
          throw new HttpError(400, "maxActiveSkills must be a positive integer");
        }
        return send(
          res,
          200,
          app.stewardService.decideSkillCandidate({
            nodeId: b.nodeId.trim(),
            decision: b.decision,
            ...(b.maxActiveSkills !== undefined ? { maxActiveSkills: b.maxActiveSkills } : {}),
          }),
        );
      }
      if (sub === "files/read" && m === "POST") {
        const b = await readJson(req);
        if (b.action === "search") {
          return send(res, 200, { ok: true, matches: app.stewardService.searchAuthorizedFiles({ ...b, callerDomain: b.callerDomain ?? domain }) });
        }
        return send(res, 200, app.stewardService.readAuthorizedFile({ ...b, callerDomain: b.callerDomain ?? domain }));
      }
      if (sub === "routing" && m === "GET") {
        return send(res, 200, app.stewardService.getRoutingDashboard());
      }
      if (sub === "routing/policy" && m === "PUT") {
        const b = await readJson(req);
        return send(res, 200, app.stewardService.updateRoutingPolicy({
          ...(typeof b.strategy === "string" ? { strategy: b.strategy } : {}),
          ...(typeof b.mode === "string" ? { mode: b.mode } : {}),
          ...(b.pinnedModel !== undefined ? { pinnedModel: b.pinnedModel ? String(b.pinnedModel) : null } : {}),
          ...(Array.isArray(b.blockedModels) ? { blockedModels: b.blockedModels.map(String) } : {}),
          ...(typeof b.unblockModel === "string" ? { unblockModel: b.unblockModel } : {}),
          ...(typeof b.resetBoosts === "boolean" ? { resetBoosts: b.resetBoosts } : {}),
          ...(typeof b.directive === "string" ? { directive: b.directive } : {}),
        }));
      }
      if (sub === "routing/sync" && m === "POST") {
        const b = await readJson(req);
        const results = await app.stewardService.syncModelPool({ ...(typeof b.providerId === "string" ? { providerId: b.providerId } : {}), force: b.force !== false });
        return send(res, 200, { ok: true, results, routing: app.stewardService.getRoutingDashboard() });
      }
      if (sub === "routing/retry-stronger" && m === "POST") {
        const b = await readJson(req);
        return send(res, 200, await app.stewardService.retryLastTurnStronger(b.callerDomain ?? domain));
      }
      if (sub === "hot-update/status" && m === "GET") {
        return send(res, 200, app.stewardService.getHotUpdateStatus());
      }
      if (sub === "hot-update/reload-ui" && m === "POST") {
        const b = await readJson(req);
        return send(res, 200, app.stewardService.triggerHotReloadUi(typeof b.file === "string" ? b.file : undefined));
      }
      if (sub === "hot-update/reload-core" && m === "POST") {
        const b = await readJson(req);
        return send(res, 200, await app.stewardService.triggerHotReloadCore({ reason: typeof b.reason === "string" ? b.reason : undefined }));
      }
      if (sub === "hot-update/stage-bundle" && m === "POST") {
        const b = await readJson(req, 25_000_000);
        if (typeof b.bundleBase64 !== "string" || !b.bundleBase64.trim()) {
          return send(res, 400, { ok: false, error: "MISSING_BUNDLE_BASE64" });
        }
        return send(res, 200, await app.stewardService.stageHotBundle(b.bundleBase64, { allowUnsigned: b.allowUnsigned === true }));
      }
      if (sub === "hot-update/rollback" && m === "POST") {
        await readJson(req);
        return send(res, 200, await app.stewardService.rollbackHotSlot());
      }
      if (sub === "hot-update/factory-reset" && m === "POST") {
        await readJson(req);
        return send(res, 200, await app.stewardService.factoryResetHotSlot());
      }
      if (sub === "vibe/artifact" && m === "GET") {
        const pid = String(url.searchParams.get("pipelineId") ?? "");
        const file = String(url.searchParams.get("file") ?? "");
        const safeFile = app.stewardService.resolveVibeArtifact(pid, file);
        if (!safeFile) throw new HttpError(404, "artifact not found");
        const buf = fs.readFileSync(safeFile);
        const mime = MIME[path.extname(safeFile).toLowerCase()] ?? "application/octet-stream";
        if (url.searchParams.get("format") === "json") {
          return send(res, 200, { fileName: path.basename(safeFile), mime, dataBase64: buf.toString("base64") });
        }
        res.writeHead(200, { "content-type": mime, "cache-control": "no-store" });
        res.end(buf);
        return;
      }
      if (sub === "avatars" && m === "GET") {
        return send(res, 200, app.stewardService.avatarStudio.listState());
      }
      if (sub === "avatars/asset" && m === "GET") {
        const id = String(url.searchParams.get("id") ?? "");
        const k = url.searchParams.get("kind");
        const allowed = new Set(["source", "blank", "sprite", "poses", "portrait", "mannequin"]);
        const kind = (k && allowed.has(k) ? k : "sprite") as "sprite" | "source" | "blank" | "poses" | "portrait" | "mannequin";
        const file = app.stewardService.avatarStudio.resolveAssetFile(id, kind);
        if (!file) throw new HttpError(404, "avatar asset not found");
        return serveFile(res, file);
      }
      if (sub === "avatars/generate" && m === "POST") {
        const b = await readJson(req);
        try {
          const out = await app.stewardService.avatarStudio.generateFromBlank(b);
          emitCompanionSignal({ kind: "studio_updated", at: Date.now() });
          return send(res, 200, out);
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
      }
      if (sub === "avatars/import" && m === "POST") {
        const b = await readJson(req, 12_000_000);
        try {
          const out = app.stewardService.avatarStudio.importFromImage(b);
          emitCompanionSignal({ kind: "studio_updated", at: Date.now() });
          return send(res, 200, out);
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
      }
      if (sub === "avatars/activate" && m === "POST") {
        const b = await readJson(req);
        const out = app.stewardService.avatarStudio.setActivePack(String(b.id ?? ""));
        emitCompanionSignal({ kind: "studio_updated", at: Date.now() });
        return send(res, 200, out);
      }
      if (sub === "avatars/customize" && m === "PUT") {
        const b = await readJson(req);
        const out = app.stewardService.avatarStudio.updatePackAppearance(b);
        emitCompanionSignal({ kind: "studio_updated", at: Date.now() });
        return send(res, 200, out);
      }
      if (seg[1] === "avatars" && seg[2] && seg.length === 3 && m === "DELETE") {
        const out = app.stewardService.avatarStudio.deletePack(seg[2]);
        emitCompanionSignal({ kind: "studio_updated", at: Date.now() });
        return send(res, 200, out);
      }
      if (sub === "companion" && m === "GET") {
        const base = app.desktop?.companionState?.() ?? { supported: false, visible: false, expanded: false };
        return send(res, 200, { ...base, lastSignal: lastCompanionSignal });
      }
      if (sub === "companion" && m === "POST") {
        const b = await readJson(req);
        const st = b.quickBar ? app.desktop?.showCompanionQuickBar?.() : app.desktop?.toggleCompanion?.(typeof b.visible === "boolean" ? b.visible : undefined);
        return send(res, 200, st ?? { supported: false, visible: false, expanded: false });
      }
      if (sub === "companion/signal" && m === "POST") {
        const b = await readJson(req);
        const kind = typeof b?.kind === "string" ? b.kind.trim() : "";
        if (!kind || !COMPANION_SIGNAL_KINDS.has(kind)) {
          throw new HttpError(400, "invalid companion signal kind");
        }
        const now = Date.now();
        const clientAt = typeof b?.at === "number" && Number.isFinite(b.at) ? Math.round(b.at) : NaN;
        const at = Number.isFinite(clientAt) && Math.abs(clientAt - now) <= 30_000 ? clientAt : now;
        const signal: CompanionSignalRecord = {
          kind,
          at,
          ...(typeof b.state === "string" && b.state.trim() ? { state: b.state.trim().slice(0, 64) } : {}),
          ...(typeof b.cue === "string" && b.cue.trim() ? { cue: b.cue.trim().slice(0, 64) } : {}),
          ...(typeof b.notice === "string" && b.notice.trim() ? { notice: b.notice.trim().slice(0, 320) } : {}),
          ...(typeof b.hash === "string" && b.hash.trim() ? { hash: b.hash.trim().slice(0, 200) } : {}),
          ...(typeof b.draftText === "string" && b.draftText.length > 0 ? { draftText: b.draftText.slice(0, 8000) } : {}),
          ...(typeof b.source === "string" && b.source.trim() ? { source: b.source.trim().slice(0, 64) } : {}),
        };
        emitCompanionSignal(signal);
        if (kind === "handoff") {
          app.desktop?.handoffCompanionToMain?.({
            hash: signal.hash,
            draftText: signal.draftText,
            source: signal.source,
          });
        }
        return send(res, 200, { ok: true, signal });
      }
      throw new HttpError(404, "not found");
    }
    if (p === "/modelflare" || p === "/modelflare/line") {
      if (m === "GET" && p === "/modelflare") return send(res, 200, app.modelflareStatus());
      if (m !== "GET" && !app.magpie) throw new HttpError(409, t("web.externalNoConnection"));
    }
    if (p === "/modelflare") {
      if (m === "PUT") {
        const b = await readJson(req);
        const apiKey = String(b.apiKey ?? "").trim();
        if (!apiKey) throw new HttpError(400, t("web.missingApiKey"));
        const r = await app.connectModelflare(apiKey, normalizeLine(b.line ?? cfg.modelflare.line));
        if (!r.ok) return send(res, 400, { error: r.message, code: r.code, status: r.status, suggestLine: r.suggestLine });
        return send(res, 200, { ...app.modelflareStatus(), models: r.models });
      }
      if (m === "DELETE") {
        if (app.account.signedIn) await app.account.logout();
        else await app.disconnectModelflare();
        return send(res, 200, app.modelflareStatus());
      }
    }
    if (p === "/modelflare/line" && m === "PUT") {
      const b = await readJson(req);
      await app.setModelflareLine(normalizeLine(b.line));
      return send(res, 200, app.modelflareStatus());
    }
    if (p === "/media/models" && m === "GET") return send(res, 200, await app.mediaModels());
    if (p === "/models/info" && m === "GET") {
      return send(res, 200, { models: await app.modelInfo(url.searchParams.get("refresh") === "1") });
    }
    if (seg[0] === "account") {
      const sub = seg.slice(1).join("/");
      if (m !== "GET" && !app.magpie) throw new HttpError(409, t("web.externalNoAccount"));
      const loginAvailable = isLoopback(host);
      const status = () => ({ ...app.account.status(), loginAvailable });
      if (sub === "" && m === "GET") return send(res, 200, status());
      if (sub === "refresh" && m === "POST") {
        if (Date.now() - app.account.status().updatedAt >= 20_000) await app.account.refresh();
        return send(res, 200, status());
      }
      if (sub === "login" && m === "POST") {
        if (!loginAvailable) throw new HttpError(409, t("web.noBrowserLogin"));
        const loginUrl = await accountCall(() => app.account.startLogin());
        app.desktop?.openExternal(loginUrl);
        return send(res, 200, { ...status(), loginUrl, opened: !!app.desktop });
      }
      if (sub === "login/cancel" && m === "POST") {
        app.account.cancelLogin();
        return send(res, 200, status());
      }
      if (sub === "logout" && m === "POST") {
        const r = await app.account.logout();
        return send(res, 200, { ...status(), revoked: r.revoked });
      }
      if (sub === "alerts" && m === "PUT") {
        const b = await readJson(req);
        const mf = cfg.modelflare;
        if (b.lowBalanceUsd !== undefined) {
          const v = normalizeLowBalance(b.lowBalanceUsd);
          if (v !== Number(b.lowBalanceUsd)) throw new HttpError(400, t("web.lowBalanceRange"));
          mf.lowBalanceUsd = v;
        }
        if (b.lowBalancePush !== undefined) mf.lowBalancePush = !!b.lowBalancePush;
        saveConfigFile(cfg.dataDir, (f) => (f.modelflare = { ...(f.modelflare ?? {}), lowBalanceUsd: mf.lowBalanceUsd, lowBalancePush: mf.lowBalancePush }));
        return send(res, 200, status());
      }
      if (sub === "usage" && m === "GET") {
        const days = Math.min(30, Math.max(1, Math.floor(Number(url.searchParams.get("days") || 7)) || 7));
        return send(res, 200, await accountCall(() => app.account.usage(days)));
      }
      if (sub === "notifications" && m === "GET") return send(res, 200, { data: await accountCall(() => app.account.notifications()) });
      if (sub === "invite" && m === "GET") return send(res, 200, await accountCall(() => app.account.invite()));
      if (sub === "budgets" && m === "GET") {
        if (!app.account.signedIn && (app.providers.hasActiveConnection() || !app.magpie)) {
          const localMap: Record<string, unknown> = {};
          for (const item of app.localBudgets.allActiveBudgets()) {
            localMap[item.botId] = {
              limit_usd: item.limitUsd,
              used_usd: item.usedUsd,
              remain_usd: item.remainUsd,
              status: item.exhausted ? "exhausted" : "active",
            };
          }
          return send(res, 200, { budgets: localMap, mode: "local" });
        }
        return send(res, 200, { budgets: await accountCall(() => app.account.botBudgets()) });
      }
    }
    if (p === "/settings") {
      if (m === "PUT") {
        const b = await readJson(req);
        if (b.defaultModel !== undefined) app.setDefaultModel(String(b.defaultModel));
        if (b.imageModel !== undefined || b.videoModel !== undefined) {
          app.setMediaModels({
            ...(b.imageModel !== undefined ? { imageModel: String(b.imageModel) } : {}),
            ...(b.videoModel !== undefined ? { videoModel: String(b.videoModel) } : {}),
          });
        }
        if (b.closeToTray !== undefined) {
          cfg.ui.closeToTray = !!b.closeToTray;
          saveConfigFile(cfg.dataDir, (f) => (f.ui = { ...(f.ui ?? {}), closeToTray: cfg.ui.closeToTray }));
        }
        if (b.zoom !== undefined) {
          const z = Number(b.zoom);
          if (!ZOOMS.includes(z)) throw new HttpError(400, t("web.badZoom"));
          cfg.ui.zoom = z;
          saveConfigFile(cfg.dataDir, (f) => (f.ui = { ...(f.ui ?? {}), zoom: z }));
          app.desktop?.applyZoom(z);
        }
        if (b.lang !== undefined) {
          const l = b.lang === "system" ? "system" : normalizeLang(b.lang);
          if (!l) throw new HttpError(400, t("web.badLang"));
          cfg.ui.lang = l as LangPref;
          saveConfigFile(cfg.dataDir, (f) => (f.ui = { ...(f.ui ?? {}), lang: l }));
          setLangPref(cfg.ui.lang);
        }
        if (b.autostart !== undefined) {
          if (!app.desktop?.autostart().supported) throw new HttpError(400, t("web.noAutostart"));
          app.desktop.setAutostart(!!b.autostart);
        }
        if (b.webSearch && typeof b.webSearch === "object") {
          const w = b.webSearch as Record<string, unknown>;
          if (w.provider !== undefined && !SEARCH_PROVIDERS.includes(w.provider as SearchProvider)) throw new HttpError(400, t("web.badSearchProvider"));
          const searxUrl = w.url === undefined ? undefined : normalizeSearxUrl(String(w.url));
          if (searxUrl === undefined && w.url !== undefined) throw new HttpError(400, t("web.badSearchUrl"));
          app.setWebSearch({
            ...(w.provider !== undefined ? { provider: w.provider as SearchProvider } : {}),
            ...(w.key !== undefined ? { key: String(w.key).trim() } : {}),
            ...(searxUrl !== undefined ? { url: searxUrl } : {}),
          });
        }
      } else if (m !== "GET") throw new HttpError(405, "method not allowed");
      return send(res, 200, {
        defaultModel: cfg.llm.defaultModel,
        imageModel: cfg.media.imageModel,
        videoModel: cfg.media.videoModel,
        closeToTray: cfg.ui.closeToTray,
        zoom: cfg.ui.zoom,
        lang: cfg.ui.lang,
        autostart: app.desktop ? app.desktop.autostart() : { supported: false, on: false },
        desktop: !!app.desktop,
        listen: { host, port: boundPort, tokenRequired: !!token },
        dataDir: cfg.dataDir,
        webSearch: app.webSearchView(),
      });
    }
    if (p === "/notices" && m === "GET") {
      const read = (f: string) => {
        try {
          return fs.readFileSync(path.join(findAppRoot(), f), "utf8");
        } catch {
          return "";
        }
      };
      return send(res, 200, { license: read("LICENSE"), notices: read("THIRD_PARTY_NOTICES.md") });
    }
    if (p === "/desktop/open-data-dir" && m === "POST") {
      if (!app.desktop) throw new HttpError(400, t("web.desktopOnly"));
      app.desktop.openDataDir();
      return send(res, 200, { ok: true });
    }
    if (p === "/desktop/update" && m === "GET") {
      if (!app.desktop?.updateStatus) throw new HttpError(400, t("web.desktopOnly"));
      return send(res, 200, app.desktop.updateStatus());
    }
    if (p === "/desktop/update/download" && m === "POST") {
      const download = app.desktop?.downloadUpdate;
      if (!download) throw new HttpError(400, t("web.desktopOnly"));
      const status = app.desktop!.updateStatus?.();
      if (!status?.supported) throw new HttpError(409, status?.error || "Updates are not supported on this build");
      if (status.state === "downloaded" || status.state === "downloading") return send(res, 200, status);
      if (status.state !== "available") throw new HttpError(409, "No update is available to download");
      return send(res, 200, download());
    }
    if (p === "/desktop/update/install" && m === "POST") {
      const desktop = app.desktop;
      const install = desktop?.installUpdate;
      if (!install || !desktop.updateStatus) throw new HttpError(400, t("web.desktopOnly"));
      const status = desktop.updateStatus();
      if (status.state !== "downloaded") throw new HttpError(409, "The update has not finished downloading");
      install();
      return send(res, 200, status);
    }
    if (p === "/desktop/self-evolution-status" && m === "GET") {
      if (!app.desktop) throw new HttpError(400, t("web.desktopOnly"));
      const report = inspectSelfEvolutionPlugins(app.config.dataDir);
      const uiArchiveNotice = getSelfEvolutionUiArchiveNotice(app.config.dataDir);
      return send(res, 200, {
        packaged: isPackagedAsar(findAppRoot()),
        overlayDir: getOverlayRepoDir(app.config.dataDir),
        uiOverlayArchived: Boolean(uiArchiveNotice),
        archivedUiPath: uiArchiveNotice?.match(/`([^`]+)`/)?.[1],
        uiArchiveNotice: uiArchiveNotice || undefined,
        plugins: report.plugins.map(({ id, manifest }) => ({ id, name: manifest.name, version: manifest.version })),
        pluginIssues: report.issues.map((issue) => ({ fileName: path.basename(issue.filePath), reason: issue.reason })),
      });
    }
    if (p === "/desktop/title-bar" && m === "POST") {
      const b = await readJson(req);
      app.desktop?.setTitleBarTheme?.(b.dark === true);
      return send(res, 200, { ok: true });
    }
    if (p === "/desktop/open-in-browser" && m === "POST") {
      if (!app.desktop) throw new HttpError(400, t("web.desktopOnly"));
      app.desktop.openInBrowser();
      return send(res, 200, { ok: true });
    }
    if (p === "/agent" && m === "GET") {
      const items = app.attention.list();
      return send(res, 200, { ...app.agent.status(), busy: [...new Set([...live.bots(), ...app.runtime.busyBots()])], background: app.tasks.background(), attention: items.length, needs: app.attention.byBot(items) });
    }
    if (seg[0] === "channel-accounts") {
      if (seg.length === 1 && m === "GET") return send(res, 200, { accounts: app.channelAccounts() });
      if (p === "/channel-accounts/new-key" && m === "POST") return send(res, 200, { key: `acct_${crypto.randomBytes(6).toString("hex")}` });
      const id = decodeURIComponent(seg[1] ?? "");
      if (!/^[\w-]{1,80}$/.test(id)) throw new HttpError(404, "not found");
      const sub = seg.slice(2).join("/");
      if (sub === "channels" && m === "GET") return send(res, 200, app.channelStatus(id));
      if (seg.length === 4 && seg[3] === "settings" && m === "PUT") {
        const b = await readJson(req);
        const r = await app.updateChannelAccount(id, seg[2], {
          ...(b.label !== undefined ? { label: String(b.label) } : {}),
          ...(b.defaultBot !== undefined ? { defaultBot: String(b.defaultBot) } : {}),
          ...(b.enabled !== undefined ? { enabled: !!b.enabled } : {}),
        });
        if (r === "taken") throw new HttpError(400, tr("web.accountNameTaken"));
        if (r === "invalid") throw new HttpError(400, tr("web.badAccountName"));
        if (r !== "ok") throw new HttpError(404, tr("web.recordNotFound"));
        return send(res, 200, { accounts: app.channelAccounts() });
      }
      if (sub === "access" && m === "GET") {
        const v = app.access.view(id);
        const owner = (ch: AccessChannel) => {
          const o = v.owners[ch];
          if (!o) return null;
          const e = (o.entryId ? app.store.getAccessById(o.entryId) : undefined) ?? { channel: ch, peerId: o.peerId, senderId: o.peerId, name: "" };
          return { peer: shortPeer(o.peerId), name: peerName(e), via: o.via };
        };
        return send(res, 200, {
          policy: v.policy,
          owners: Object.fromEntries(ACCESS_CHANNELS.map((ch) => [ch, owner(ch)])),
          requests: v.requests.map(publicAccess),
          entries: v.entries.filter((e) => e.status !== "owner").map(publicAccess),
        });
      }
      if (seg[2] === "access" && seg.length === 5 && m === "POST") {
        const entry = app.store.getAccessById(decodeURIComponent(seg[3]));
        if (!entry || entry.botId !== id) throw new HttpError(404, tr("web.recordNotFound"));
        if (seg[4] === "approve" || seg[4] === "deny") {
          const r = app.access.decide(entry.id, seg[4] === "approve", "web");
          if (!r) throw new HttpError(409, tr("web.requestAlreadyHandled"));
          return send(res, 200, { entry: publicAccess(r) });
        }
      }
      if (seg[2] === "access" && seg[3] === "owner" && seg.length === 5 && m === "DELETE") {
        const ch = seg[4];
        if (!isPushChannel(ch)) throw new HttpError(404, tr("web.noSuchChannel"));
        if (app.access.owner(id, ch)?.via === "login") throw new HttpError(409, tr("web.weixinOwnerRescan"));
        app.access.resetOwner(id, ch);
        return send(res, 200, { ok: true });
      }
      if (seg[2] === "access" && seg.length === 4 && m === "DELETE") {
        const entry = app.store.getAccessById(decodeURIComponent(seg[3]));
        if (!entry || entry.botId !== id) throw new HttpError(404, tr("web.recordNotFound"));
        app.access.remove(entry.id);
        return send(res, 200, { ok: true });
      }
      if (sub === "feishu" && m === "PUT") {
        const b = await readJson(req);
        await app.connectFeishu(id, String(b.appId ?? "").trim(), String(b.appSecret ?? "").trim());
        return send(res, 200, app.channelStatus(id));
      }
      if (sub === "feishu/one-click" && m === "POST") {
        const flow = app.connections.feishu.startAppFlow(async (created) => {
          await app.connectFeishu(id, created.appId, created.appSecret, created.brand);
          return app.store.getChannelAccount(id, "feishu")?.label ?? "";
        });
        return send(res, 200, { flow });
      }
      if (sub === "feishu" && m === "DELETE") {
        await app.removeChannelAccount(id, "feishu");
        return send(res, 200, app.channelStatus(id));
      }
      if (isMessenger(sub) && m === "PUT") {
        try {
          await app.connectMessenger(id, sub, await readJson(req));
        } catch (e) {
          if ((e as PlatformError).rejected) throw new HttpError(400, (e as Error).message);
          throw e;
        }
        return send(res, 200, app.channelStatus(id));
      }
      if (isMessenger(sub) && m === "DELETE") {
        await app.removeChannelAccount(id, sub);
        return send(res, 200, app.channelStatus(id));
      }
      if (sub === "weixin" && m === "PUT") {
        const b = await readJson(req);
        await app.updateChannelAccount(id, "weixin", { enabled: !!b.enabled });
        return send(res, 200, app.channelStatus(id));
      }
      if (sub === "weixin/login" && m === "POST") {
        const login = app.startWeixinLogin(id);
        const t0 = Date.now();
        while (login.snapshot.state === "idle" || login.snapshot.state === "fetching") {
          if (Date.now() - t0 > 10_000) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        return send(res, 200, login.snapshot);
      }
      if (sub === "weixin/login" && m === "GET") return send(res, 200, app.channels.get(id)?.weixinLogin?.snapshot ?? { state: "idle" });
      if (sub === "weixin/verify" && m === "POST") {
        const b = await readJson(req);
        app.channels.get(id)?.weixinLogin?.submitVerifyCode(String(b.code ?? ""));
        return send(res, 200, { ok: true });
      }
      if (sub === "weixin/cancel" && m === "POST") {
        app.channels.get(id)?.weixinLogin?.cancel();
        return send(res, 200, { ok: true });
      }
      if (sub === "weixin/logout" && m === "POST") {
        await app.removeChannelAccount(id, "weixin");
        return send(res, 200, app.channelStatus(id));
      }
      throw new HttpError(405, "method not allowed");
    }
    if (seg[0] === "connections") {
      const c = app.connections;
      const guard = async <T>(run: () => Promise<T>): Promise<T> => {
        try {
          return await run();
        } catch (e) {
          if (e instanceof ConnectionError) throw new HttpError(400, e.message);
          throw e;
        }
      };
      if (seg.length === 1 && m === "GET") return send(res, 200, { accounts: c.accounts.view() });
      if (p === "/connections/notion/token" && m === "POST") {
        const b = await readJson(req);
        const tokenVal = String(b.token ?? "").trim();
        if (!tokenVal) throw new HttpError(400, t("web.notionTokenRejected"));
        const who = await c.notion.verifyToken(tokenVal);
        if (who.rejected) throw new HttpError(400, t("web.notionTokenRejected"));
        c.accounts.upsert({ service: "notion", label: who.label, identity: who.identity, auth: { kind: "notion-token", token: tokenVal } });
        return send(res, 200, { accounts: c.accounts.view() });
      }
      if (p === "/connections/notion/oauth" && m === "POST") {
        const authUrl = await guard(() => c.notion.startAuthorization(`${LOOPBACK_HTTP}127.0.0.1:${boundPort}${NOTION_CALLBACK}`));
        return send(res, 200, { url: authUrl });
      }
      if (p === "/connections/feishu" && m === "POST") {
        const b = await readJson(req);
        const appId = String(b.appId ?? "").trim();
        const appSecret = String(b.appSecret ?? "").trim();
        if (Boolean(appId) !== Boolean(appSecret)) throw new HttpError(400, t("web.feishuAppIncomplete"));
        return send(res, 200, { flow: c.feishu.startFlow(appId ? { appId, appSecret } : undefined) });
      }
      if (seg[1] === "flows" && seg[2]) {
        if (m === "DELETE") {
          c.feishu.cancelFlow(seg[2]);
          return send(res, 200, { ok: true });
        }
        const flow = c.feishu.flow(seg[2]);
        if (!flow) throw new HttpError(404, "not found");
        return send(res, 200, { flow, accounts: c.accounts.view() });
      }
      if (seg.length === 2 && m === "PUT") {
        const b = await readJson(req);
        const renamed = c.accounts.rename(seg[1], String(b.label ?? ""));
        if (renamed !== "ok") throw new HttpError(400, t(renamed === "taken" ? "web.accountNameTaken" : "web.badAccountName"));
        return send(res, 200, { accounts: c.accounts.view() });
      }
      if (seg.length === 2 && m === "DELETE") {
        c.accounts.remove(seg[1]);
        return send(res, 200, { accounts: c.accounts.view() });
      }
      throw new HttpError(405, "method not allowed");
    }
    if (seg[0] === "attention") {
      if (seg.length === 1 && m === "GET") return send(res, 200, { items: app.attention.list() });
      const id = decodeURIComponent(seg[1] ?? "");
      const action = seg[2] ?? "";
      if (seg.length !== 3 || m !== "POST") throw new HttpError(404, "not found");
      const item = app.attention.list().find((x) => x.id === id);
      if (!item) throw new HttpError(409, tr("web.alreadyHandled"));
      if (!(item.actions as string[]).includes(action)) throw new HttpError(400, tr("web.unsupportedAction"));
      const b = await readJson(req);
      let ok = false;
      if (action === "approve" || action === "deny") ok = app.agent.approvals.decide(item.approvalId!, action === "approve", "web");
      else if (action === "answer") {
        ok = Array.isArray(b.answers)
          ? app.agent.approvals.answer(item.approvalId!, { answers: b.answers.map((a: any) => ({ id: String(a.id), selected: (a.selected ?? []).map(String), ...(a.custom ? { custom: String(a.custom) } : {}) })) }, "web")
          : app.agent.approvals.answerText(item.approvalId!, String(b.text ?? ""), "web");
      } else if (item.kind === "delivery" && (action === "retry" || action === "dismiss")) ok = app.delivery.act(item.id, action);
      else if (item.kind === "suggest") ok = action === "act" ? !app.tasks.updateRule(item.ruleId!, { mode: "act" }).error : app.tasks.keepObserving(item.ruleId!);
      else if (item.kind === "rule" && action === "retry") ok = !app.tasks.resumeRule(item.ruleId!).error;
      else if (item.kind === "rule" && action === "continue") ok = !app.tasks.addRuleBudget(item.ruleId!).error;
      else if (action === "continue") ok = !(await app.tasks.addBudget(item.taskId!, undefined, "web")).error;
      else if (action === "retry") ok = !(await app.tasks.retry(item.taskId!)).error;
      else if (action === "stop") ok = await app.tasks.stopTask(item.taskId!, "web");
      if (!ok) throw new HttpError(409, tr("web.couldntComplete"));
      app.attention.kick();
      return send(res, 200, { ok: true, items: app.attention.list() });
    }
    if (seg[0] === "tasks") {
      if (seg.length === 1 && m === "GET") {
        const recent = url.searchParams.get("recent");
        const groups = (url.searchParams.get("group") || "").split(",").map((g) => g.trim()).filter(Boolean);
        if (groups.some((g) => !["working", "needs", "ended"].includes(g))) throw new HttpError(400, tr("web.badGroup"));
        return send(res, 200, {
          tasks: app.tasks.list({
            botId: url.searchParams.get("bot") || undefined,
            conversationId: url.searchParams.get("conversation") || undefined,
            since: recent ? Date.now() - Math.min(30, Math.max(0, Number(recent) || 1)) * 86400_000 : undefined,
            limit: Math.min(100, Number(url.searchParams.get("limit")) || 50),
            group: groups as StageGroup[],
          }),
        });
      }
      const task = seg[1] ? app.tasks.get(decodeURIComponent(seg[1])) : undefined;
      if (!task) throw new HttpError(404, tr("web.taskNotFound"));
      if (seg.length === 2 && m === "GET") {
        const runs = app.store
          .listRuns({ taskId: task.id })
          .map((r) => ({ id: r.id, cause: r.cause, state: r.state, outcome: r.outcome, error: r.error, costUsd: r.costUsd, queuedAt: r.queuedAt, startedAt: r.startedAt, endedAt: r.endedAt, steps: app.tasks.activity(r.id).length }));
        return send(res, 200, { task, runs, origin: app.tasks.origin(task.id), sizes: app.tasks.sizes(task.id), canOpen: !!app.desktop?.openPath });
      }
      if (seg.length === 2 && m === "DELETE") {
        await app.tasks.deleteTask(task.id, "web");
        return send(res, 200, { ok: true });
      }
      if (seg.length === 3 && seg[2] === "budget" && m === "POST") {
        const b = await readJson(req);
        const r =
          b.budgetUsd !== undefined
            ? await app.tasks.setBudget(task.id, Number(b.budgetUsd), "web")
            : await app.tasks.addBudget(task.id, b.addUsd === undefined ? undefined : Number(b.addUsd), "web");
        if (r.error) throw new HttpError(400, r.error);
        return send(res, 200, { task: r.task });
      }
      if (seg.length === 3 && seg[2] === "keep" && m === "POST") {
        const v = app.tasks.keepFolder(task.id);
        if (!v) throw new HttpError(409, tr("web.couldntComplete"));
        return send(res, 200, { task: v });
      }
      if (seg.length === 3 && seg[2] === "open" && m === "POST") {
        const dir = app.tasks.folderPath(task.id);
        if (!app.desktop?.openPath) throw new HttpError(400, tr("web.desktopOnly"));
        if (!dir) throw new HttpError(404, tr("web.taskNotFound"));
        fs.mkdirSync(dir, { recursive: true });
        app.desktop.openPath(dir);
        return send(res, 200, { ok: true });
      }
      if (seg.length === 3 && seg[2] === "export" && m === "GET") {
        const r = withLang(normalizeLang(url.searchParams.get("lang")), () => app.tasks.exportTask(task.id));
        if (!r) throw new HttpError(404, tr("web.taskNotFound"));
        return sendMarkdown(res, r.title, r.text);
      }
      if (seg.length === 5 && seg[2] === "runs" && seg[4] === "activity" && m === "GET") {
        const run = app.store.getRun(decodeURIComponent(seg[3]));
        if (!run || run.taskId !== task.id) throw new HttpError(404, tr("web.runNotFound"));
        return send(res, 200, { steps: app.tasks.activity(run.id) });
      }
      if (seg.length === 3 && seg[2] === "stop" && m === "POST") {
        const ok = await app.tasks.stopTask(task.id, "web");
        if (!ok) throw new HttpError(409, tr("web.taskAlreadyStopped"));
        return send(res, 200, { task: app.tasks.get(task.id) });
      }
      throw new HttpError(404, "not found");
    }
    if (seg[0] === "rules") {
      const scheduleOf = (raw: unknown, tz: string): Schedule => {
        const r = normalizeSchedule(raw, tz, Date.now());
        if (!r.schedule) throw new HttpError(400, r.error ?? t("rules.badSchedule"));
        return r.schedule;
      };
      if (seg.length === 1 && m === "GET") {
        return send(res, 200, { rules: app.tasks.listRules({ botId: url.searchParams.get("bot") || undefined, conversationId: url.searchParams.get("conversation") || undefined }) });
      }
      if (seg.length === 1 && m === "POST") {
        const b = await readJson(req);
        if (b.mode !== undefined && !["observe", "act"].includes(b.mode)) throw new HttpError(400, t("rules.badMode"));
        const r = app.tasks.createRule({
          botId: String(b.botId ?? ""),
          conversationId: String(b.conversationId ?? ""),
          title: String(b.title ?? ""),
          instruction: String(b.instruction ?? ""),
          kind: b.kind === "remind" ? "remind" : "check",
          ...(b.mode === "observe" ? { mode: "observe" as const } : {}),
          message: String(b.message ?? ""),
          schedule: scheduleOf(b.schedule, app.delivery.timeZone),
          ...(b.runBudgetUsd !== undefined ? { runBudgetUsd: Number(b.runBudgetUsd) } : {}),
          ...(b.monthBudgetUsd !== undefined ? { monthBudgetUsd: Number(b.monthBudgetUsd) } : {}),
        });
        if (!r.rule) throw new HttpError(400, r.error ?? t("rules.createFailed"));
        return send(res, 200, { rule: app.tasks.getRuleView(r.rule.id) });
      }
      const rule = seg[1] ? app.store.getRule(decodeURIComponent(seg[1])) : undefined;
      if (!rule) throw new HttpError(404, t("rules.notFound"));
      if (seg.length === 2 && m === "GET") return send(res, 200, { rule: app.tasks.getRuleView(rule.id) });
      if (seg.length === 2 && m === "PUT") {
        const b = await readJson(req);
        const patch: Parameters<typeof app.tasks.updateRule>[1] = {};
        if (b.title !== undefined) patch.title = String(b.title);
        if (b.instruction !== undefined) patch.instruction = String(b.instruction);
        if (b.message !== undefined) patch.message = String(b.message);
        if (b.conversationId !== undefined) patch.conversationId = String(b.conversationId);
        if (b.runBudgetUsd !== undefined) patch.runBudgetUsd = Number(b.runBudgetUsd);
        if (b.monthBudgetUsd !== undefined) patch.monthBudgetUsd = Number(b.monthBudgetUsd);
        if (b.mode !== undefined) {
          if (!["off", "observe", "act"].includes(b.mode)) throw new HttpError(400, t("rules.badMode"));
          patch.mode = b.mode as RuleMode;
        }
        if (b.schedule !== undefined) patch.schedule = scheduleOf(b.schedule, rule.trigger.kind === "schedule" ? rule.trigger.schedule.tz : app.delivery.timeZone);
        const r = app.tasks.updateRule(rule.id, patch);
        if (!r.rule) throw new HttpError(400, r.error ?? t("rules.saveFailed"));
        return send(res, 200, { rule: app.tasks.getRuleView(rule.id) });
      }
      if (seg.length === 2 && m === "DELETE") {
        await app.tasks.deleteRule(rule.id);
        return send(res, 200, { ok: true });
      }
      if (seg.length === 3 && seg[2] === "run" && m === "POST") {
        const r = rule.pausedReason ? app.tasks.resumeRule(rule.id) : app.tasks.runRuleNow(rule.id);
        if (r.error) throw new HttpError(409, r.error);
        return send(res, 200, { rule: app.tasks.getRuleView(rule.id) });
      }
      if (seg.length === 3 && seg[2] === "runs" && m === "GET") {
        const before = Number(url.searchParams.get("before")) || undefined;
        return send(res, 200, { runs: app.tasks.ruleLog(rule.id, { before, limit: Math.min(100, Number(url.searchParams.get("limit")) || 20) }) });
      }
      if (seg.length === 3 && seg[2] === "export" && m === "GET") {
        const r = withLang(normalizeLang(url.searchParams.get("lang")), () => app.tasks.exportRule(rule.id));
        if (!r) throw new HttpError(404, t("rules.notFound"));
        return sendMarkdown(res, r.title, r.text);
      }
      if (seg.length === 5 && seg[2] === "runs" && seg[4] === "activity" && m === "GET") {
        const run = app.store.getRun(decodeURIComponent(seg[3]));
        if (!run || run.ruleId !== rule.id) throw new HttpError(404, t("rules.runNotFound"));
        return send(res, 200, { steps: app.tasks.activity(run.id) });
      }
      throw new HttpError(404, "not found");
    }
    if (seg[0] === "pwsh") {
      const view = () => ({ ...pwshProbe.snapshot(), dismissed: cfg.ui.pwshHintDismissed });
      const setMode = (mode: PwshMode) => {
        if (cfg.agent.pwsh === mode) return;
        cfg.agent.pwsh = mode;
        saveConfigFile(cfg.dataDir, (f) => (f.agent = { ...(f.agent ?? {}), pwsh: mode }));
      };
      if (seg.length === 1 && m === "GET") {
        await pwshProbe.check();
        return send(res, 200, view());
      }
      if (seg[1] === "recheck" && m === "POST") {
        await pwshProbe.check(true);
        return send(res, 200, view());
      }
      if (seg[1] === "install" && m === "POST") {
        if (process.platform !== "win32" || !pwshProbe.applicable) throw new HttpError(400, tr("web.windowsOnly"));
        const b = await readJson(req);
        setMode("auto");
        await pwshProbe.check();
        pwshProbe.install({ reinstall: !!b.reinstall });
        return send(res, 200, view());
      }
      if (seg[1] === "mode" && m === "PUT") {
        const b = await readJson(req);
        const mode: PwshMode = b.mode === "system" ? "system" : "auto";
        setMode(mode);
        pwshProbe.setMode(mode);
        return send(res, 200, view());
      }
      if (seg.length === 1 && m === "PUT") {
        const b = await readJson(req);
        if (b.dismissed !== undefined) {
          cfg.ui.pwshHintDismissed = !!b.dismissed;
          saveConfigFile(cfg.dataDir, (f) => (f.ui = { ...(f.ui ?? {}), pwshHintDismissed: cfg.ui.pwshHintDismissed }));
        }
        await pwshProbe.check();
        return send(res, 200, view());
      }
      throw new HttpError(405, "method not allowed");
    }
    if (p === "/guide") {
      const save = (g: GuideState) => {
        cfg.ui.guide = g;
        saveConfigFile(cfg.dataDir, (f) => (f.ui = { ...(f.ui ?? {}), guide: g }));
      };
      if (m === "PUT") {
        const b = await readJson(req);
        const add: unknown[] = b.done === undefined ? [] : Array.isArray(b.done) ? b.done : [b.done];
        if (!add.every(isGuideStep)) throw new HttpError(400, t("web.unknownGuideStep"));
        const g = b.reset ? normalizeGuide({}) : cfg.ui.guide;
        save(normalizeGuide({
          done: [...g.done, ...add],
          hidden: b.hidden !== undefined ? !!b.hidden : g.hidden,
          seen: [...g.seen, ...(typeof b.seen === "string" ? [b.seen] : [])],
        }));
      } else if (m !== "GET") throw new HttpError(405, "method not allowed");
      const bots = app.store.listBots();
      const derived = deriveGuide({
        conversations: app.store.listConversations(),
        bots,
        channelBound: () => app.store.listChannelAccounts().length > 0,
        memoryCount: (id) =>
          [{ kind: "bot" as const, id }, { kind: "team" as const, id: "" }].reduce((n, s) => n + app.agent.memory.entries(s).length + app.agent.memory.topics(s).length, 0),
      });
      const merged = mergeGuide(cfg.ui.guide, derived);
      if (merged.done.length !== cfg.ui.guide.done.length) save(merged);
      return send(res, 200, { steps: GUIDE_STEPS, ...cfg.ui.guide });
    }
    if (seg[0] === "diagnostics") {
      const sub = seg.slice(1).join("/");
      if (sub === "" && m === "GET") return send(res, 200, safeStatus(app));
      if (sub === "logs" && m === "GET") {
        const n = Math.min(Math.max(Number(url.searchParams.get("lines")) || 200, 1), 2000);
        return send(res, 200, { file: logFilePath() ?? "", lines: readLogTail(n) });
      }
      if (sub === "report" && m === "GET") return send(res, 200, { text: diagnosticsReport(app, Math.min(Math.max(Number(url.searchParams.get("lines")) || 200, 1), 2000)) });
      if (sub === "test-model" && m === "POST") {
        const b = await readJson(req);
        const botId = b.botId ? String(b.botId) : undefined;
        if (botId && !app.store.getBot(botId)) throw new HttpError(404, t("web.botNotFound"));
        return send(res, 200, await testModel(app, { botId, model: b.model ? String(b.model) : undefined, timeoutMs: b.timeoutMs ? Number(b.timeoutMs) : undefined }));
      }
      if (sub === "test-agent" && m === "POST") {
        const b = await readJson(req);
        const botId = b.botId ? String(b.botId) : undefined;
        if (botId && !app.store.getBot(botId)) throw new HttpError(404, t("web.botNotFound"));
        return send(res, 200, await testAgent(app, { botId, model: b.model ? String(b.model) : undefined, timeoutMs: b.timeoutMs ? Number(b.timeoutMs) : undefined }));
      }
      if (sub === "restart-agent" && m === "POST") {
        const b = await readJson(req);
        const restarted = await app.agent.restartHosts(b.botId ? String(b.botId) : undefined);
        log.info("agent hosts restarted from troubleshooting", { restarted });
        return send(res, 200, { restarted, agent: (safeStatus(app) as any).agent });
      }
      throw new HttpError(404, "not found");
    }
    if (seg[0] === "approvals") {
      if (seg.length === 1 && m === "GET") {
        const status = url.searchParams.get("status") || undefined;
        return send(res, 200, { approvals: app.store.listApprovals({ status: status as any, botId: url.searchParams.get("bot") || undefined, limit: 100 }).map((r) => publicApproval(r, app.store)) });
      }
      const row = seg[1] ? app.store.getApproval(decodeURIComponent(seg[1])) : undefined;
      if (!row) throw new HttpError(404, t("web.requestNotFound"));
      if (seg.length === 2 && m === "GET") return send(res, 200, { approval: publicApproval(row, app.store) });
      if (seg.length === 3 && m === "POST" && (seg[2] === "approve" || seg[2] === "deny")) {
        if (row.kind !== "approval") throw new HttpError(400, t("web.notApproval"));
        const ok = app.agent.approvals.decide(row.id, seg[2] === "approve", "web");
        if (!ok) throw new HttpError(409, t("web.requestDone"));
        return send(res, 200, { approval: publicApproval(app.store.getApproval(row.id)!, app.store) });
      }
      if (seg.length === 3 && m === "POST" && seg[2] === "answer") {
        if (row.kind !== "question" || row.status !== "pending") throw new HttpError(409, t("web.requestDone"));
        const b = await readJson(req);
        const ok = Array.isArray(b.answers)
          ? app.agent.approvals.answer(row.id, { answers: b.answers.map((a: any) => ({ id: String(a.id), selected: (a.selected ?? []).map(String), ...(a.custom ? { custom: String(a.custom) } : {}) })) }, "web")
          : app.agent.approvals.answerText(row.id, String(b.text ?? ""), "web");
        if (!ok) throw new HttpError(409, t("web.submitFailed"));
        return send(res, 200, { approval: publicApproval(app.store.getApproval(row.id)!, app.store) });
      }
    }
    if (seg[0] === "conversations") {
      if (seg.length === 1 && m === "GET") return send(res, 200, { conversations: app.store.listConversations(url.searchParams.get("bot") || undefined) });
      if (seg.length === 3 && seg[2] === "messages" && m === "GET") {
        const conv = app.store.getConversation(decodeURIComponent(seg[1]));
        if (!conv) throw new HttpError(404, t("web.conversationNotFound"));
        return send(res, 200, { conversation: conv, messages: app.store.listMessages(conv.id).map(publicMessage), canOpen: !!app.desktop?.openPath });
      }
      if (seg.length === 5 && seg[2] === "messages" && seg[4] === "activity" && m === "GET") {
        return send(res, 200, { steps: app.store.getActivity(decodeURIComponent(seg[1]), Number(seg[3])) });
      }
      if (seg.length === 3 && seg[2] === "turn" && m === "GET") {
        const turnInProg = app.agent.turnsInProgress.get(decodeURIComponent(seg[1]));
        return send(res, 200, { turn: turnInProg ? { since: turnInProg.since, lastProgress: turnInProg.lastProgress, steps: turnInProg.activity.steps, interim: turnInProg.interim } : null });
      }
      if (seg.length === 3 && seg[2] === "stop" && m === "POST") {
        return send(res, 200, { stopped: stopConversation(decodeURIComponent(seg[1])) });
      }
      if (seg[2] === "file" && (seg.length === 3 ? m === "GET" : seg.length === 4 && (seg[3] === "open" || seg[3] === "reveal") && m === "POST")) {
        const conv = app.store.getConversation(decodeURIComponent(seg[1]));
        if (!conv) throw new HttpError(404, t("web.conversationNotFound"));
        const desktop = app.desktop;
        if (m === "POST" && !desktop?.openPath) throw new HttpError(400, t("web.desktopOnly"));
        const input = m === "GET" ? url.searchParams.get("path") : (await readJson(req)).path;
        const ws = botWorkspace(cfg.dataDir, conv.botId);
        const f = ws ? resolveFile(String(input ?? ""), { workspace: ws, dataDir: cfg.dataDir, delivered: app.store.deliveredFiles(conv.id) }) : undefined;
        if (!f) throw new HttpError(404, t("web.fileNotFound"));
        if (m === "GET") return sendFile(req, res, f);
        if (seg[3] === "open" && !runnable(f)) {
          desktop!.openPath!(f.path);
          return send(res, 200, { ok: true });
        }
        if (desktop!.showItemInFolder) desktop!.showItemInFolder(f.path);
        else desktop!.openPath!(path.dirname(f.path));
        return send(res, 200, { ok: true, revealed: true });
      }
    }
    if (seg[0] === "bots") {
      if (seg.length === 1) {
        if (m === "GET") return send(res, 200, { bots: app.store.listBots().map(publicBot) });
        if (m === "POST") {
          const b = await readJson(req);
          if (!String(b.name || "").trim()) throw new HttpError(400, t("web.nameRequired"));
          const bot = app.store.createBot({
            name: String(b.name).trim(),
            systemPrompt: String(b.systemPrompt ?? ""),
            defaultModel: String(b.defaultModel ?? ""),
            settings: normalizeSettings({ avatar: b.avatar }),
          });
          await app.startBot(bot.id);
          return send(res, 201, { bot: publicBot(bot) });
        }
      }
      const id = seg[1];
      const bot = id ? app.store.getBot(id) : undefined;
      if (!bot) throw new HttpError(404, t("web.botNotFound"));
      if (seg.length === 2) {
        if (m === "GET") return send(res, 200, { bot: publicBot(bot) });
        if (m === "PUT") {
          const b = await readJson(req);
          const next = app.store.updateBot(id, {
            ...(b.name !== undefined ? { name: String(b.name) } : {}),
            ...(b.systemPrompt !== undefined ? { systemPrompt: String(b.systemPrompt) } : {}),
            ...(b.defaultModel !== undefined ? { defaultModel: String(b.defaultModel) } : {}),
          })!;
          return send(res, 200, { bot: publicBot(next) });
        }
        if (m === "DELETE") {
          await app.deleteBot(id);
          return send(res, 200, { ok: true });
        }
      }
      const sub = seg.slice(2).join("/");
      if (sub === "settings" && m === "GET") return send(res, 200, { settings: bot.settings, computerUse: app.agent.computerUse(id) });
      if (sub === "settings" && m === "PUT") {
        const b = await readJson(req);
        const cur = bot.settings;
        const merged = normalizeSettings({
          ...cur,
          ...(b.permission !== undefined ? { permission: b.permission } : {}),
          ...(b.selfEvolution !== undefined ? { selfEvolution: { ...cur.selfEvolution, ...b.selfEvolution } } : {}),
          ...(b.utilityModel !== undefined ? { utilityModel: b.utilityModel } : {}),
          ...(b.avatar !== undefined ? { avatar: b.avatar } : {}),
          ...(b.computerUse !== undefined ? { computerUse: { ...cur.computerUse, ...b.computerUse } } : {}),
          ...(b.media !== undefined ? { media: { ...cur.media, ...b.media } } : {}),
          ...(b.quietHours !== undefined ? { quietHours: { ...cur.quietHours, ...b.quietHours } } : {}),
          ...(b.nudge !== undefined ? { nudge: b.nudge } : {}),
          memory: { ...cur.memory, ...(b.memory ?? {}) },
          steward: { ...cur.steward, ...(b.steward ?? {}) },
        });
        app.store.updateBot(id, { settings: merged });
        if (cur.selfEvolution.enabled !== merged.selfEvolution.enabled) {
          for (const c of app.store.listConversations(id)) {
            app.store.clearAgentSession(c.id);
          }
        }
        if (typeof b.paused === "boolean") app.tasks.setPaused(id, b.paused, "web");
        try {
          app.agent.host(id).syncPrompt(true);
        } catch {
          /* ignore */
        }
        void app.agent.refreshIdle();
        const next = app.store.getBot(id)!;
        return send(res, 200, { settings: next.settings, computerUse: app.agent.computerUse(id) });
      }
      if (sub === "budget" && m === "PUT") {
        const b = await readJson(req);
        const limitUsd = Number(b.limitUsd ?? bot.settings.budget.limitUsd);
        if (!Number.isFinite(limitUsd) || limitUsd < 0 || limitUsd > 100_000) throw new HttpError(400, t("web.budgetRange"));
        const next = await accountCall(() => app.setBotBudget(id, normalizeSettings({ budget: { enabled: !!b.enabled, limitUsd } }).budget));
        return send(res, 200, { settings: next.settings });
      }
      if (sub === "memory" && m === "GET") {
        const scopes = [
          { kind: "team" as const, id: "" },
          { kind: "bot" as const, id },
          ...app.store
            .listConversations(id)
            .filter((c) => c.kind === "group")
            .map((c) => ({ kind: "group" as const, id: c.id })),
        ];
        return send(res, 200, {
          scopes: scopes.map((s) => ({
            kind: s.kind,
            id: s.id,
            label: scopeLabel(s),
            entries: app.agent.memory.entries(s).map((e) => ({ text: e.text, meta: e.meta })),
            topics: app.agent.memory.topics(s).map((tp) => ({ name: tp, entries: app.agent.memory.entries(s, tp).map((e) => ({ text: e.text, meta: e.meta })) })),
          })),
          journal: app.agent.memory.journalTail(30).filter((j) => j.scope === "team" || j.scope.includes(id)),
          steward: app.agent.stewardLog.filter((l) => l.conversationId.startsWith(id + ":")).slice(-20),
        });
      }
      if (sub === "memory/forget" && m === "POST") {
        const b = await readJson(req);
        const kind = String(b.kind ?? "bot");
        const scope = kind === "team" ? { kind: "team" as const, id: "" } : kind === "group" ? { kind: "group" as const, id: String(b.id ?? "") } : { kind: "bot" as const, id };
        if (scope.kind === "group" && !scope.id.startsWith(id + ":")) throw new HttpError(400, t("web.groupNotOwned"));
        try {
          const text = app.agent.memory.forget(scope, String(b.match ?? ""), { topic: b.topic ? String(b.topic) : undefined, by: "web" });
          return send(res, 200, { ok: true, text });
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
      }
      if (sub === "chat" && m === "GET") {
        const conv = app.store.getConversation(consoleConvId(id));
        const turns = live.list(consoleConvId(id));
        const cut = turns[0]?.afterMessageId ?? Infinity;
        return send(res, 200, {
          conversationId: consoleConvId(id),
          model: conv?.model ?? "",
          messages: conv ? app.store.listMessages(conv.id, 200).filter((x) => x.id <= cut).map(publicMessage) : [],
          pending: app.store.listApprovals({ status: "pending", conversationId: consoleConvId(id), limit: 50 }).map((r) => publicApproval(r, app.store)),
          live: turns.map((lt) => lt.snapshot()),
          canOpen: !!app.desktop?.openPath,
        });
      }
      if (sub === "chat/live" && m === "GET") {
        const lt = live.get(consoleConvId(id), url.searchParams.get("turn"));
        const out = new SseReply(res);
        if (!lt) return out.end("done", { conversationId: consoleConvId(id), ended: true });
        out.send("snapshot", lt.snapshot());
        const off = lt.subscribe((e, d) => (e === "done" || e === "error" ? out.end(e, d) : out.send(e, d)));
        res.on("close", off);
        return;
      }
      if (sub === "chat/model" && m === "PUT") {
        const b = await readJson(req);
        const conv = app.store.ensureConversation(id, "web", "console", "控制台");
        app.store.setConversationModel(conv.id, String(b.model ?? ""));
        return send(res, 200, { conversationId: conv.id, model: String(b.model ?? "") });
      }
      if (sub === "chat" && m === "POST") {
        const b = await readJson(req);
        const text = String(b.text ?? "").trim();
        if (!text) throw new HttpError(400, t("web.emptyText"));
        const ev = webEvent(id, text);
        const intercepted = interceptWeb(ev);
        if (intercepted.handled) return send(res, 200, { reply: intercepted.ack ?? "", prompts: [] });
        const out = new CollectReply();
        const lt = startLive(id, text);
        await runLive(lt, ev, { apply: async (op) => (await lt.apply(op), await out.apply(op)) });
        return send(res, 200, { reply: out.text, prompts: out.prompts, files: out.files, conversationId: consoleConvId(id) });
      }
      if (sub === "chat/stream" && m === "POST") {
        const b = await readJson(req);
        const text = String(b.text ?? "").trim();
        if (!text) throw new HttpError(400, t("web.emptyText"));
        const ev = webEvent(id, text);
        const out = new SseReply(res);
        try {
          const intercepted = interceptWeb(ev);
          if (intercepted.handled) {
            if (intercepted.ack) out.send("text", { text: intercepted.ack, final: true, ack: true });
            return out.end("done", { conversationId: consoleConvId(id) });
          }
        } catch (e) {
          return out.end("error", { message: (e as Error).message });
        }
        const lt = startLive(id, text);
        const off = lt.subscribe((e, d) => (e === "done" || e === "error" ? out.end(e, d) : out.send(e, d)));
        res.on("close", off);
        await runLive(lt, ev);
        return;
      }
    }
    throw new HttpError(404, "not found");
  }

  function serveFile(res: http.ServerResponse, file: string): void {
    fs.readFile(file, (err, data) => {
      if (err) return void res.writeHead(404).end("not found");
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
      res.end(data);
    });
  }

  async function notionCallback(res: http.ServerResponse, url: URL): Promise<void> {
    let title = t("web.oauthDone");
    let detail = t("web.oauthClose");
    try {
      const account = await app.connections.notion.finishAuthorization({ state: url.searchParams.get("state"), code: url.searchParams.get("code"), error: url.searchParams.get("error") });
      detail = `${account.label} · ${detail}`;
    } catch (e) {
      title = t("web.oauthFailed");
      detail = e instanceof ConnectionError ? e.message : t("web.oauthFailedRetry");
      if (!(e instanceof ConnectionError)) log.warn("notion authorization failed", { message: (e as Error).message });
    }
    const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" }).end(
      `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:16px system-ui,sans-serif;display:grid;place-content:center;min-height:90vh;text-align:center"><h1 style="font-size:20px;font-weight:600">${escape(title)}</h1><p>${escape(detail)}</p></body>`,
    );
  }

  const server = http.createServer((req, res) => {
    const scope = requestLang(normalizeLang(req.headers["x-amb-lang"]));
    res.once("close", scope.end);
    scope.run(() => handle(req, res));
  });
  function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || "/", `${LOOPBACK_HTTP}localhost`);
    if (url.pathname === NOTION_CALLBACK && req.method === "GET") {
      void notionCallback(res, url);
      return;
    }
    if (!authorized(req, url, res)) return;
    if (url.pathname.startsWith("/amb/api/")) {
      api(req, res, url).catch((e) => {
        const status = e instanceof HttpError ? e.status : 500;
        if (status === 500) log.error("api error", { path: url.pathname, message: (e as Error).message });
        if (!res.headersSent) send(res, status, { error: (e as Error).message });
      });
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") return serveFile(res, resolveOverlayUiFile(cfg.dataDir, uiDir, "index.html"));
    if (url.pathname === "/companion" || url.pathname === "/companion.html") return serveFile(res, resolveOverlayUiFile(cfg.dataDir, uiDir, "companion.html"));
    if (url.pathname.startsWith("/amb/static/")) {
      const rel = path.normalize(url.pathname.slice("/amb/static/".length)).replace(/^(\.\.[/\\])+/, "");
      return serveFile(res, resolveOverlayUiFile(cfg.dataDir, uiDir, rel));
    }
    if (url.pathname.startsWith("/amb/vendor/")) {
      const f = vendor[url.pathname.slice("/amb/vendor/".length)];
      if (!f) return void res.writeHead(404).end();
      return serveFile(res, f);
    }
    if (url.pathname === "/amb/healthz") return send(res, 200, { ok: true });
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
  }
  server.on("upgrade", (_req, socket) => socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"));

  const port = opts.port ?? cfg.ui.port;
  const listen = (p: number) =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(p, host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  let virtualBound = false;
  try {
    await listen(port);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EPERM" && port === 0) {
      virtualBound = true;
      boundPort = 43210;
    } else if (code !== "EADDRINUSE") {
      throw e;
    } else {
      log.warn(`端口 ${port} 被占用，改用随机端口`);
      await listen(0);
    }
  }
  if (!virtualBound) {
    boundPort = (server.address() as import("node:net").AddressInfo).port;
  }
  const shownHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const webUrl = `${LOOPBACK_HTTP}${shownHost}:${boundPort}/`;
  log.info(`UI: ${webUrl}`);

  const inject = (pathname: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const sock = new Duplex({ read() {}, write(_chunk, _enc, cb) { cb(); } }) as unknown as import("node:net").Socket;
      const req = new http.IncomingMessage(sock);
      req.method = init.method ?? "GET";
      req.url = pathname;
      req.headers = {
        host: `${shownHost}:${boundPort}`,
        ...(token ? { "x-amb-token": token } : {}),
        ...(init.headers ?? {}),
      };
      const res = new http.ServerResponse(req);
      const chunks: Buffer[] = [];
      const origWrite = res.write.bind(res);
      const origEnd = res.end.bind(res);
      (res as any).write = (chunk: any, ...rest: any[]) => {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        return origWrite(chunk, ...rest);
      };
      (res as any).end = (chunk?: any, ...rest: any[]) => {
        if (chunk && typeof chunk !== "function") {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
        const ret = origEnd(chunk, ...rest);
        resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") });
        return ret;
      };
      req.on("error", reject);
      res.on("error", reject);
      server.emit("request", req, res);
      if (init.body !== undefined) req.push(Buffer.from(init.body, "utf8"));
      req.push(null);
    });

  return {
    url: webUrl,
    port: boundPort,
    token,
    inject,
    close: () =>
      server.listening
        ? new Promise<void>((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          })
        : Promise.resolve(),
  };
}
