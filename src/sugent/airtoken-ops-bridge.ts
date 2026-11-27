import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type AirTokenOpsAction =
  | "status"
  | "epoch"
  | "extend"
  | "mode"
  | "lock"
  | "reclaim"
  | "maintenance"
  | "unlock";

export interface AirTokenOpsConfig {
  configured: boolean;
  apiOrigin: string;
  publicDashboardUrl: string;
  commandToken: string;
}

export interface AirTokenOpsClientOptions {
  env?: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
  homeDir?: string;
  extraEnvFiles?: readonly string[];
  timeoutMs?: number;
}

export interface AirTokenOpsCommandResponse {
  ok: boolean;
  command?: string;
  replyMarkdown: string;
  configured: boolean;
  statusCode?: number;
  error?: string;
}

const DEFAULT_AIRTOKEN_ORIGIN = "http://127.0.0.1:8787";
const VALID_EXTEND_PRESETS = new Set(["30m", "4h", "8h", "12h"]);
const VALID_MODES = new Set(["paper", "dry_run", "canary"]);
const VALID_MAINT_SUBS = new Set(["status", "approve_window", "approve_now", "defer_24h", "cancel"]);

function parseEnvFileReadOnly(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    if (!filePath || !fs.existsSync(filePath)) return out;
    for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key) out[key] = val;
    }
  } catch {
    // read-only best effort
  }
  return out;
}

export function normalizeAirTokenUrls(rawUrl?: string, rawDashboardUrl?: string): {
  apiOrigin: string;
  publicDashboardUrl: string;
} {
  const pick = String(rawUrl || rawDashboardUrl || DEFAULT_AIRTOKEN_ORIGIN).trim() || DEFAULT_AIRTOKEN_ORIGIN;
  const withScheme = /^https?:\/\//i.test(pick) ? pick : `https://${pick}`;
  let apiOrigin = DEFAULT_AIRTOKEN_ORIGIN;
  try {
    const parsed = new URL(withScheme);
    apiOrigin = parsed.origin;
  } catch {
    apiOrigin = DEFAULT_AIRTOKEN_ORIGIN;
  }
  const dashRaw = String(rawDashboardUrl || "").trim();
  const publicDashboardUrl = dashRaw && /^https?:\/\//i.test(dashRaw)
    ? dashRaw.split("#", 1)[0]!.replace(/\/+$/, "")
    : `${apiOrigin}/dashboard`;
  return { apiOrigin, publicDashboardUrl };
}

export function resolveAirTokenOpsConfig(options: AirTokenOpsClientOptions = {}): AirTokenOpsConfig {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const candidates = [
    ...(options.extraEnvFiles ?? []),
    path.join(homeDir, ".gemini", "config", ".ops_credentials.env"),
    "/opt/airtoken/.env",
    path.join(homeDir, "Projects", "airtoken", ".env"),
  ];
  const fileVars: Record<string, string> = {};
  if (!options.env) {
    for (const fp of candidates) {
      Object.assign(fileVars, parseEnvFileReadOnly(fp));
    }
  }
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = String(env[k] ?? fileVars[k] ?? "").trim();
      if (v) return v;
    }
    return "";
  };
  const { apiOrigin, publicDashboardUrl } = normalizeAirTokenUrls(
    pick("AIRTOKEN_OPS_URL", "SUGENT_AIRTOKEN_OPS_URL"),
    pick("AIRTOKEN_PUBLIC_DASHBOARD_URL"),
  );
  const commandToken = pick("AIRTOKEN_IM_COMMAND_TOKEN", "SUGENT_AIRTOKEN_IM_TOKEN");
  return {
    configured: Boolean(commandToken),
    apiOrigin,
    publicDashboardUrl,
    commandToken,
  };
}

export function detectAirTokenSecretLeak(text: string, publicDashboardUrl = `${DEFAULT_AIRTOKEN_ORIGIN}/dashboard`): string | null {
  const clean = String(text || "").trim();
  if (!clean) return null;
  const restoreUrl = `${publicDashboardUrl.split("#", 1)[0]}?restore_mode=CANARY_SEMI_AUTO#unlock`;
  const hasUnlockCmdArg = /^\s*\/unlock\s+\S+/i.test(clean);
  const mentionsVault = /(?:airtoken|金库|vault|unlock|解锁)/i.test(clean);
  const hasInlineSecret =
    /(?:密码|口令|password|passphrase|私钥|private\s*key|助记词|mnemonic)\s*[:：=是为]?\s*\S{4,}/i.test(clean) ||
    /0x[0-9a-fA-F]{64}/.test(clean) ||
    /\b[a-z]{3,10}(?:\s+[a-z]{3,10}){11,23}\b/i.test(clean) ||
    /^(?:帮我)?(?:解锁|unlock)\s+(?:airtoken|金库)\s+(?!模式|状态|链接|地址)\S{6,}$/i.test(clean);
  if (!hasUnlockCmdArg && !(mentionsVault && hasInlineSecret)) {
    return null;
  }
  return [
    "🛑 **安全拦截：严禁在微信或任何聊天窗中发送主密码、私钥或助记词！**",
    "本次消息已在进入大模型与对话历史前就地拦截。",
    `如需冷启动解锁，请点击安全 HTTPS 控制台链接（支持手机密码管理器面容填充）：\n${restoreUrl}`,
  ].join("\n");
}

export type ParsedAirTokenShortcut =
  | { kind: "command"; command: string }
  | { kind: "smart_unlock" };

function parseExtendPreset(text: string): string {
  const m = text.match(/(?:^|\s)(30m|4h|8h|12h)(?:\s|$)/i) || text.match(/(30|4|8|12)\s*(?:小时|h|分钟|m)/i);
  if (!m?.[1]) return "8h";
  const tok = m[1].toLowerCase();
  if (VALID_EXTEND_PRESETS.has(tok)) return tok;
  if (tok === "30") return "30m";
  if (tok === "4" || tok === "8" || tok === "12") return `${tok}h`;
  return "8h";
}

export function parseAirTokenNaturalShortcut(text: string): ParsedAirTokenShortcut | null {
  const clean = String(text || "").trim();
  if (!clean) return null;
  const slashMatch = clean.match(/^\s*\/(?:airtoken|at)(?:\s+([\s\S]*))?$/i);
  if (slashMatch) {
    const rest = String(slashMatch[1] || "").trim();
    if (!rest) return { kind: "command", command: "/status" };
    const [headRaw, ...args] = rest.split(/\s+/);
    const head = (headRaw || "status").toLowerCase();
    if (head === "unlock") return { kind: "smart_unlock" };
    if (head === "extend") {
      const p = args[0] && VALID_EXTEND_PRESETS.has(args[0].toLowerCase()) ? args[0].toLowerCase() : parseExtendPreset(rest);
      return { kind: "command", command: `/extend ${p}` };
    }
    if (head === "mode" && args[0] && VALID_MODES.has(args[0].toLowerCase())) {
      return { kind: "command", command: `/mode ${args[0].toLowerCase()}` };
    }
    if (head === "maintenance") {
      const sub = args[0] && VALID_MAINT_SUBS.has(args[0].toLowerCase()) ? args[0].toLowerCase() : "status";
      return { kind: "command", command: `/maintenance ${sub}` };
    }
    if (head === "reclaim") {
      const flags = args.filter((a) => a === "--burn-dust" || a === "--dry-run").join(" ");
      return { kind: "command", command: flags ? `/reclaim ${flags}` : "/reclaim" };
    }
    if (head === "status" || head === "epoch" || head === "lock") {
      return { kind: "command", command: `/${head}` };
    }
    return { kind: "command", command: `/${rest.replace(/^\/+/, "")}` };
  }

  const mentionsAirToken = /airtoken/i.test(clean);
  const mentionsVault = /金库/.test(clean) && /(?:续期|续一下|锁死|锁库|解锁|切回纸盘|切到纸盘|canary|dry_run)/i.test(clean);
  if (!mentionsAirToken && !mentionsVault) return null;
  if (/^(?:怎么|如何|为什么|能否|可不可以|解释)/.test(clean) && !/解锁/.test(clean)) return null;

  if (/(?:解锁|unlock)/i.test(clean)) return { kind: "smart_unlock" };
  if (/(?:锁死|锁库|紧急停机|立即上锁|锁定金库)/.test(clean)) return { kind: "command", command: "/lock" };
  if (/(?:续期|续一下|续个|延长|续命|续杯|续\s*(?:30|4|8|12|半)|\bextend\b)/i.test(clean)) {
    return { kind: "command", command: `/extend ${parseExtendPreset(clean)}` };
  }
  if (/(?:战绩|收益|盈亏|净利|epoch)/i.test(clean)) return { kind: "command", command: "/epoch" };
  if (/(?:切|改|换|回|开启|恢复|暂停)/.test(clean) && /(?:纸盘|paper|canary|实盘|dry_run|dry-run|预演)/i.test(clean)) {
    if (/(?:纸盘|paper|暂停实盘)/i.test(clean)) return { kind: "command", command: "/mode paper" };
    if (/(?:dry_run|dry-run|预演)/i.test(clean)) return { kind: "command", command: "/mode dry_run" };
    return { kind: "command", command: "/mode canary" };
  }
  if (/(?:退租|回收.*租金|空\s*ata|烧.*粉尘)/i.test(clean)) {
    const flags: string[] = [];
    if (/粉尘|burn|销毁/i.test(clean)) flags.push("--burn-dust");
    if (/dry|演练|预演|预览/i.test(clean)) flags.push("--dry-run");
    return { kind: "command", command: flags.length ? `/reclaim ${flags.join(" ")}` : "/reclaim" };
  }
  if (/(?:维护状态|批准维护|立即维护|延后维护|取消维护|maintenance)/i.test(clean)) {
    if (/立即/.test(clean)) return { kind: "command", command: "/maintenance approve_now" };
    if (/批准|窗口/.test(clean)) return { kind: "command", command: "/maintenance approve_window" };
    if (/延后|推迟/.test(clean)) return { kind: "command", command: "/maintenance defer_24h" };
    if (/取消/.test(clean)) return { kind: "command", command: "/maintenance cancel" };
    return { kind: "command", command: "/maintenance status" };
  }
  if (/(?:状态|在跑吗|还剩多久|过期了吗|剩余时间|解锁了吗|status|情况怎么样)/i.test(clean)) {
    return { kind: "command", command: "/status" };
  }
  return null;
}

export class AirTokenOpsBridgeClient {
  private readonly cfg: AirTokenOpsConfig;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: AirTokenOpsClientOptions = {}) {
    this.cfg = resolveAirTokenOpsConfig(opts);
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  getConfig(): AirTokenOpsConfig {
    return this.cfg;
  }

  isConfigured(): boolean {
    return this.cfg.configured;
  }

  async runCommand(command: string): Promise<AirTokenOpsCommandResponse> {
    if (!this.cfg.configured) {
      return {
        ok: false,
        configured: false,
        error: "AIRTOKEN_IM_COMMAND_TOKEN_UNSET",
        replyMarkdown:
          "⚠️ 尚未配置 AirToken 运维令牌（`AIRTOKEN_IM_COMMAND_TOKEN`）。请在 Sugent `.env` 中配置后重试，或直接打开控制台：" +
          `${this.cfg.publicDashboardUrl}?restore_mode=CANARY_SEMI_AUTO#unlock`,
      };
    }
    const url = `${this.cfg.apiOrigin}/api/ops/im-command`;
    try {
      const res = await this.fetchFn(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.cfg.commandToken}`,
        },
        body: JSON.stringify({ command }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const errMsg = String(data.error || `HTTP ${res.status}`).slice(0, 180);
        return {
          ok: false,
          configured: true,
          statusCode: res.status,
          error: errMsg,
          replyMarkdown: `⚠️ AirToken 控制台返回错误（HTTP ${res.status}）：${errMsg}`,
        };
      }
      return {
        ok: Boolean(data.ok ?? true),
        configured: true,
        statusCode: res.status,
        ...(typeof data.command === "string" ? { command: data.command } : {}),
        replyMarkdown: String(data.reply_markdown || "✅ 指令已执行。"),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        configured: true,
        error: msg,
        replyMarkdown: `⚠️ 连接 AirToken 控制台失败：${msg.slice(0, 160)}`,
      };
    }
  }
}

export interface AirTokenOpsToolInput {
  action: AirTokenOpsAction;
  preset?: "30m" | "4h" | "8h" | "12h";
  targetMode?: "paper" | "dry_run" | "canary";
  burnDust?: boolean;
  dryRun?: boolean;
  maintenanceAction?: "status" | "approve_window" | "approve_now" | "defer_24h" | "cancel";
}

export function buildAirTokenBridgeMethods(client: AirTokenOpsBridgeClient) {
  const smartUnlock = async (): Promise<AirTokenOpsCommandResponse> => {
    const st = await client.runCommand("/status");
    if (st.ok && /`UNLOCKED`/.test(st.replyMarkdown)) {
      const ttlMatch = st.replyMarkdown.match(/IPC TTL 剩余[^\d]*([\d.]+)m/);
      const remMin = ttlMatch ? Number(ttlMatch[1]) : 0;
      if (remMin > 0) {
        return {
          ok: true,
          configured: true,
          command: "status",
          replyMarkdown: [
            `✅ **金库当前已处于 \`UNLOCKED\` 解锁状态**（IPC 会话剩余约 **${remMin.toFixed(1)} 分钟**），无需重新输入主密码。`,
            "如果只是担心快过期，直接对我说「续期 airtoken 8h」或「续期 airtoken 12h」即可免密续杯。",
            st.replyMarkdown,
          ].join("\n\n"),
        };
      }
    }
    if (!client.isConfigured()) {
      const cfg = client.getConfig();
      return {
        ok: true,
        configured: false,
        command: "unlock",
        replyMarkdown: `🔐 请点击安全控制台链接输入主密码解锁（严禁在聊天框发送密码）：\n${cfg.publicDashboardUrl}?restore_mode=CANARY_SEMI_AUTO#unlock`,
      };
    }
    return client.runCommand("/unlock");
  };

  const handleShortcut = async (text: string): Promise<{ handled: boolean; reply?: string }> => {
    const cfg = client.getConfig();
    const leakMsg = detectAirTokenSecretLeak(text, cfg.publicDashboardUrl);
    if (leakMsg) return { handled: true, reply: leakMsg };
    const parsed = parseAirTokenNaturalShortcut(text);
    if (!parsed) return { handled: false };
    const res = parsed.kind === "smart_unlock" ? await smartUnlock() : await client.runCommand(parsed.command);
    return { handled: true, reply: res.replyMarkdown };
  };

  const executeAction = async (input: AirTokenOpsToolInput): Promise<Record<string, unknown>> => {
    if (input.action === "unlock") {
      const res = await smartUnlock();
      return { ok: res.ok, configured: res.configured, command: res.command ?? "unlock", replyMarkdown: res.replyMarkdown };
    }
    let cmd = `/${input.action}`;
    if (input.action === "extend") {
      const p = input.preset && VALID_EXTEND_PRESETS.has(input.preset) ? input.preset : "8h";
      cmd = `/extend ${p}`;
    } else if (input.action === "mode") {
      const m = input.targetMode && VALID_MODES.has(input.targetMode) ? input.targetMode : "paper";
      cmd = `/mode ${m}`;
    } else if (input.action === "reclaim") {
      const flags = [input.burnDust ? "--burn-dust" : "", input.dryRun ? "--dry-run" : ""].filter(Boolean).join(" ");
      cmd = flags ? `/reclaim ${flags}` : "/reclaim";
    } else if (input.action === "maintenance") {
      const sub = input.maintenanceAction && VALID_MAINT_SUBS.has(input.maintenanceAction) ? input.maintenanceAction : "status";
      cmd = `/maintenance ${sub}`;
    }
    const res = await client.runCommand(cmd);
    return {
      ok: res.ok,
      configured: res.configured,
      command: res.command ?? input.action,
      replyMarkdown: res.replyMarkdown,
      ...(res.error ? { error: res.error } : {}),
    };
  };

  return { smartUnlock, handleShortcut, executeAction };
}
