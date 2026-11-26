import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const DEDUP_WINDOW_MS = 2_000;
const PAIR_CONTEXT_MAX_GAP_MS = 30 * 60_000;
const DEFAULT_HYDRATE_MAX_MESSAGES = 20;
const DEFAULT_HYDRATE_MAX_CHARS = 16_000;
const DEFAULT_RECALL_DAYS_BACK = 3;
const DEFAULT_RECALL_LIMIT = 24;
const MAX_RECALL_LIMIT = 60;
const MAX_SNIPPET_CHARS = 360;

export type TranscriptRole = "user" | "assistant";
export type RecallChannelFilter = "all" | "weixin" | "feishu" | "web" | "web_ui";

export interface ChatTranscriptRecallServiceOptions {
  dataDir: string;
  db?: DatabaseSync;
  getDb?: () => DatabaseSync | undefined;
  nowMs?: () => number;
}

export interface DirectStewardTurnInput {
  channel: string;
  peerId?: string;
  role: TranscriptRole;
  content: string;
  createdAtMs?: number;
}

export interface DirectStewardTurnRecordResult {
  recorded: boolean;
  deduplicated: boolean;
  filePath: string;
}

export interface StoredWebTurnRecord {
  channel: string;
  peerId: string;
  role: TranscriptRole;
  content: string;
  createdAtMs: number;
}

export interface HydrateRecentPeerHistoryInput {
  channel: string;
  peerId: string;
  maxMessages?: number;
  maxChars?: number;
}

export interface HydratedPeerTurn {
  role: TranscriptRole;
  content: string;
}

export interface RecallChatHistoryInput {
  query?: string;
  daysBack?: number;
  sinceIso?: string;
  untilIso?: string;
  channel?: RecallChannelFilter;
  limit?: number;
  ownerOnly?: boolean;
  nowMs?: number;
}

export interface ChatHistoryRecallItem {
  atIso: string;
  dateKey: string;
  channel: string;
  role: TranscriptRole;
  snippet: string;
}

export interface ChatHistoryRecallResult {
  ok: true;
  windowStartIso: string;
  windowEndIso: string;
  totalMatched: number;
  channelsCovered: string[];
  items: ChatHistoryRecallItem[];
}

interface InternalTurn {
  conversationKey: string;
  channel: string;
  peerId: string;
  role: TranscriptRole;
  content: string;
  rawContent: string;
  createdAtMs: number;
  seq: number;
}

const API_KEY_PATTERN = /\b(?:sk|clikey|cpa-admin|tok|emp)-[A-Za-z0-9_-]{8,}\b/g;
const URL_TOKEN_PATTERN = /([?&]token=)[A-Za-z0-9_-]{12,}/g;
const BEARER_TOKEN_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi;

const CHINESE_NUMERALS: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

const STOP_WORDS = new Set([
  "我们",
  "咱们",
  "咱俩",
  "我和你",
  "你和我",
  "我跟你",
  "你跟我",
  "我没",
  "我",
  "你",
  "他",
  "她",
  "它",
  "都",
  "也",
  "还",
  "到底",
  "究竟",
  "关于",
  "有关",
  "记录",
  "对话",
  "聊天",
  "消息",
  "内容",
  "事情",
  "东西",
  "问题",
  "话题",
  "什么",
  "些什么",
  "啥",
  "些啥",
  "哪些",
  "有哪些",
  "是什么",
  "怎么",
  "吗",
  "呢",
  "啊",
  "呀",
  "吧",
  "的",
  "了",
  "过",
  "么",
  "和",
  "与",
  "跟",
  "在",
  "里",
  "上",
  "what",
  "about",
  "chat",
  "history",
  "transcript",
  "message",
  "messages",
  "conversation",
  "conversations",
  "we",
  "did",
  "do",
  "you",
  "know",
  "remember",
  "talk",
  "talked",
  "discuss",
  "discussed",
]);

export function redactTranscriptSecrets(text: string): string {
  if (!text) return "";
  return text
    .replace(API_KEY_PATTERN, "[REDACTED_KEY]")
    .replace(URL_TOKEN_PATTERN, "$1[REDACTED]")
    .replace(BEARER_TOKEN_PATTERN, "$1[REDACTED_KEY]");
}

function parseChineseCount(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  const direct = CHINESE_NUMERALS[trimmed];
  if (direct !== undefined) return direct;
  if (trimmed.length === 2 && trimmed.startsWith("十")) {
    const unit = trimmed[1] ? CHINESE_NUMERALS[trimmed[1]] : undefined;
    if (unit !== undefined) return 10 + unit;
  }
  if (trimmed.length === 2 && trimmed.endsWith("十")) {
    const tens = trimmed[0] ? CHINESE_NUMERALS[trimmed[0]] : undefined;
    if (tens !== undefined) return tens * 10;
  }
  return undefined;
}

function resolveImplicitDaysBack(query: string): number {
  let daysBack = DEFAULT_RECALL_DAYS_BACK;
  const q = query.trim().toLowerCase();
  if (!q) return daysBack;

  if (q.includes("昨天") || q.includes("昨日") || /\byesterday\b/.test(q)) {
    daysBack = Math.max(daysBack, 2);
  }
  if (q.includes("前天") && !q.includes("大前天")) {
    daysBack = Math.max(daysBack, 4);
  }
  if (q.includes("大前天")) {
    daysBack = Math.max(daysBack, 5);
  }
  if (q.includes("本周") || q.includes("这周") || /\bthis\s+week\b/.test(q)) {
    daysBack = Math.max(daysBack, 7);
  }
  if (
    q.includes("上周") ||
    q.includes("上星期") ||
    q.includes("上礼拜") ||
    q.includes("最近一周") ||
    q.includes("过去一周") ||
    /\blast\s+week\b/.test(q)
  ) {
    daysBack = Math.max(daysBack, 14);
  }
  if (q.includes("上个月") || q.includes("上月") || q.includes("最近一个月") || /\blast\s+month\b/.test(q)) {
    daysBack = Math.max(daysBack, 35);
  }

  const relDaysMatch = q.match(/(?:最近|过去|前)?\s*(\d+|[一二两三四五六七八九十]{1,2})\s*(?:天|日)/);
  if (relDaysMatch?.[1]) {
    const n = parseChineseCount(relDaysMatch[1]);
    if (n !== undefined && n > 0) daysBack = Math.min(365, Math.max(daysBack, n + 1));
  }
  return daysBack;
}

function extractRecallKeywords(rawQuery: string): string[] {
  if (!rawQuery || rawQuery.trim().length === 0) return [];
  let cleaned = rawQuery
    .toLowerCase()
    .replace(/[？?！!。，,、；;：:“”"‘’'（）()【】[\]《》<>—…·~～/\\]+/g, " ");

  const timePatterns: RegExp[] = [
    /\b\d{4}-\d{1,2}-\d{1,2}\b/g,
    /(?:最近|过去|前)?\s*(?:\d+|[一二两三四五六七八九十]{1,2})\s*(?:个?(?:小时|钟头|月|星期|礼拜)|天|日|周|分钟)(?:前|内|里|以来)?/g,
    /(?:上上个?周|上个?(?:周|星期|礼拜)|这周|本周|这个?(?:星期|礼拜)|上个?月|这个?月|本月)/g,
    /(?:大前天|前天|昨天|昨日|今天|今日|刚才|刚刚|方才|昨晚|今早|前几天|这几天|那几天|那天|最近|近期|之前|以前)/g,
    /\b(?:yesterday|today|just\s+now|recently|last\s+(?:week|month)|this\s+(?:week|month))\b/g,
  ];
  for (const pat of timePatterns) cleaned = cleaned.replace(pat, " ");

  const metaPatterns: RegExp[] = [
    /你?还记得吗|记不记得|你?记得吗|你?知道吗|能告诉我吗|帮我(?:查一下|查查|看看|找一下|找找|回忆一下|回顾一下|总结一下)/g,
    /在(?:微信|飞书|网页端?|web_?ui|web端?)(?:里|上|中|那边|这边)?/g,
    /(?:我们|咱们|咱俩|我和你|你和我|我跟你|你跟我|我没|我|你)\s*(?:都|一共|总共)?\s*(?:聊|说|讲|讨论|谈|提到?|问|发|写)(?:了|过|的)?(?:些什么|什么|些啥|啥)?/g,
    /(?:聊|说|讲|讨论|谈|提到?|问)(?:了|过)(?:些什么|什么|些啥|啥)/g,
    /(?:聊|说|讲|讨论|谈|提到?)(?:了|过|的)/g,
    /(?:聊天记录|对话记录|历史对话|历史记录|历史消息|聊天内容|对话内容|消息记录)/g,
  ];
  for (const pat of metaPatterns) cleaned = cleaned.replace(pat, " ");

  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawTok of cleaned.split(/\s+/)) {
    const tok = rawTok
      .replace(/^(?:关于|有关)+/, "")
      .replace(/(?:的事情|的问题|的内容|的记录|的对话|吗|呢|啊|呀|吧)+$/, "")
      .trim();
    if (tok && !STOP_WORDS.has(tok) && !seen.has(tok)) {
      seen.add(tok);
      out.push(tok);
    }
  }
  return out;
}

function extractCjkBigrams(token: string): string[] {
  const cjkRuns = token.match(/[\u4e00-\u9fff]{4,}/g);
  if (!cjkRuns) return [];
  const bigrams: string[] = [];
  const seen = new Set<string>();
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length - 1; i += 1) {
      const bg = run.slice(i, i + 2);
      if (!seen.has(bg)) {
        seen.add(bg);
        bigrams.push(bg);
      }
    }
  }
  return bigrams;
}

function scoreTurnAgainstKeywords(content: string, keywords: string[]): number {
  if (keywords.length === 0) return 1;
  const lower = content.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) {
      score += 3;
      continue;
    }
    const bigrams = extractCjkBigrams(kw);
    if (bigrams.length >= 3) {
      let hits = 0;
      for (const bg of bigrams) if (lower.includes(bg)) hits += 1;
      if (hits >= 2) score += hits * 0.8;
    }
  }
  return score;
}

function clipSnippet(redactedText: string, maxLen = MAX_SNIPPET_CHARS): string {
  const normalized = redactedText.trim();
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen - 3)}...`;
}

function selectTimeBrowseSlice(
  mergedTurns: InternalTurn[],
  limit: number,
  rawQuery: string,
  nowMs: number,
): InternalTurn[] {
  if (mergedTurns.length <= limit) return mergedTurns;
  const q = rawQuery.trim().toLowerCase();
  if ((q.includes("昨天") || q.includes("昨日") || /\byesterday\b/.test(q)) && !q.includes("今天")) {
    const focusStartMs = nowMs - 2 * DAY_MS;
    const focusEndMs = nowMs - 10 * HOUR_MS;
    const focused = mergedTurns.filter((t) => t.createdAtMs >= focusStartMs && t.createdAtMs <= focusEndMs);
    if (focused.length >= limit) return focused.slice(-limit);
    if (focused.length > 0) {
      const set = new Set(focused);
      const rest = mergedTurns.filter((t) => !set.has(t)).slice(-(limit - focused.length));
      return [...focused, ...rest].sort((a, b) => a.createdAtMs - b.createdAtMs || a.seq - b.seq);
    }
  }
  return mergedTurns.slice(-limit);
}

export class ChatTranscriptRecallService {
  private readonly dataDir: string;
  private readonly explicitDb: DatabaseSync | undefined;
  private readonly getDbFn: (() => DatabaseSync | undefined) | undefined;
  private readonly nowMsFn: () => number;

  constructor(options: ChatTranscriptRecallServiceOptions) {
    this.dataDir = options.dataDir;
    this.explicitDb = options.db;
    this.getDbFn = options.getDb;
    this.nowMsFn = options.nowMs ?? (() => Date.now());
  }

  getWebTurnsFilePath(): string {
    return path.join(this.dataDir, "sugent-stewardship", "steward-web-turns.jsonl");
  }

  private resolveDb(): DatabaseSync | undefined {
    return this.explicitDb ?? this.getDbFn?.();
  }

  private hasDuplicateInSqlite(channel: string, role: TranscriptRole, rawContent: string, createdAtMs: number): boolean {
    const db = this.resolveDb();
    if (!db) return false;
    try {
      const dbChannel = channel === "web_ui" ? "web" : channel;
      const row = db
        .prepare(
          `SELECT m.id FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
           WHERE c.channel = ? AND m.role = ? AND m.content = ?
             AND ABS(m.created_at - ?) <= ?
           LIMIT 1`,
        )
        .get(dbChannel, role, rawContent, createdAtMs, DEDUP_WINDOW_MS) as { id?: number } | undefined;
      return Boolean(row?.id);
    } catch {
      return false;
    }
  }

  recordDirectStewardTurn(input: DirectStewardTurnInput): DirectStewardTurnRecordResult {
    const filePath = this.getWebTurnsFilePath();
    const rawContent = String(input.content ?? "").trim();
    if (!rawContent) {
      return { recorded: false, deduplicated: false, filePath };
    }
    const createdAtMs = input.createdAtMs ?? this.nowMsFn();
    const channel = String(input.channel ?? "web_ui").trim().toLowerCase() || "web_ui";
    const peerId = String(input.peerId ?? "owner").trim() || "owner";

    if (this.hasDuplicateInSqlite(channel, input.role, rawContent, createdAtMs)) {
      return { recorded: false, deduplicated: true, filePath };
    }

    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const record: StoredWebTurnRecord = {
      channel,
      peerId,
      role: input.role,
      content: redactTranscriptSecrets(rawContent),
      createdAtMs,
    };
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // ignore chmod on unsupported fs
    }
    return { recorded: true, deduplicated: false, filePath };
  }

  private readDirectWebTurns(): StoredWebTurnRecord[] {
    const filePath = this.getWebTurnsFilePath();
    if (!fs.existsSync(filePath)) return [];
    const out: StoredWebTurnRecord[] = [];
    try {
      for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const rec = JSON.parse(trimmed) as Partial<StoredWebTurnRecord>;
          if (
            (rec.role === "user" || rec.role === "assistant") &&
            typeof rec.content === "string" &&
            typeof rec.createdAtMs === "number"
          ) {
            out.push({
              channel: typeof rec.channel === "string" ? rec.channel : "web_ui",
              peerId: typeof rec.peerId === "string" ? rec.peerId : "owner",
              role: rec.role,
              content: redactTranscriptSecrets(rec.content),
              createdAtMs: rec.createdAtMs,
            });
          }
        } catch {
          // skip malformed line
        }
      }
    } catch {
      return [];
    }
    return out;
  }

  hydrateRecentPeerHistory(input: HydrateRecentPeerHistoryInput): HydratedPeerTurn[] {
    const channel = input.channel.trim().toLowerCase();
    const peerId = input.peerId.trim();
    const maxMessages = Math.max(2, input.maxMessages ?? DEFAULT_HYDRATE_MAX_MESSAGES);
    const maxChars = Math.max(500, input.maxChars ?? DEFAULT_HYDRATE_MAX_CHARS);

    let candidates: Array<{ role: TranscriptRole; content: string; createdAtMs: number; seq: number }> = [];
    if (channel === "web_ui") {
      candidates = this.readDirectWebTurns()
        .filter((t) => t.channel === "web_ui" && (!peerId || t.peerId === peerId))
        .map((t, idx) => ({ role: t.role, content: t.content, createdAtMs: t.createdAtMs, seq: idx }));
    } else {
      const db = this.resolveDb();
      if (db && peerId) {
        try {
          const rows = db
            .prepare(
              `SELECT m.id, m.role, m.content, m.created_at
               FROM messages m
               JOIN conversations c ON c.id = m.conversation_id
               WHERE c.channel = ? AND c.peer_id = ? AND c.kind != 'group'
                 AND m.role IN ('user', 'assistant')
               ORDER BY m.created_at DESC, m.id DESC
               LIMIT ?`,
            )
            .all(channel, peerId, maxMessages * 2) as Array<{
            id: number;
            role: TranscriptRole;
            content: string;
            created_at: number;
          }>;
          candidates = rows
            .reverse()
            .map((r) => ({
              role: r.role,
              content: redactTranscriptSecrets(r.content),
              createdAtMs: r.created_at,
              seq: r.id,
            }));
        } catch {
          candidates = [];
        }
      }
    }

    const bounded: HydratedPeerTurn[] = [];
    let chars = 0;
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const item = candidates[i]!;
      if (!item.content.trim()) continue;
      if (bounded.length >= maxMessages) break;
      if (chars + item.content.length > maxChars && bounded.length > 0) break;
      bounded.unshift({ role: item.role, content: item.content });
      chars += item.content.length;
    }

    while (bounded.length > 0 && bounded[0]?.role !== "user") {
      bounded.shift();
    }
    return bounded;
  }

  private resolveOwnerPeers(db: DatabaseSync): { hasAnyOwnerConfig: boolean; allowedByChannel: Map<string, Set<string>> } {
    const allowedByChannel = new Map<string, Set<string>>();
    let hasAnyOwnerConfig = false;
    const addPeer = (ch: string, peer: string) => {
      if (!peer) return;
      hasAnyOwnerConfig = true;
      let set = allowedByChannel.get(ch);
      if (!set) {
        set = new Set();
        allowedByChannel.set(ch, set);
      }
      set.add(peer);
    };

    try {
      const wxRows = db
        .prepare("SELECT owner_user_id FROM weixin_accounts WHERE owner_user_id != ''")
        .all() as Array<{ owner_user_id: string }>;
      for (const r of wxRows) addPeer("weixin", r.owner_user_id);
    } catch {
      // table may not exist
    }

    try {
      const accRows = db
        .prepare("SELECT channel, peer_id FROM access WHERE status = 'owner' AND peer_id != ''")
        .all() as Array<{ channel: string; peer_id: string }>;
      for (const r of accRows) addPeer(r.channel, r.peer_id);
    } catch {
      // table may not exist
    }

    return { hasAnyOwnerConfig, allowedByChannel };
  }

  recallChatHistory(input: RecallChatHistoryInput = {}): ChatHistoryRecallResult {
    const nowMs = input.nowMs ?? this.nowMsFn();
    const rawQuery = String(input.query ?? "").trim();
    const ownerOnly = input.ownerOnly !== false;
    const channelFilter: RecallChannelFilter = input.channel ?? "all";
    const limit = Math.min(MAX_RECALL_LIMIT, Math.max(1, input.limit ?? DEFAULT_RECALL_LIMIT));

    const daysBack = input.daysBack ?? resolveImplicitDaysBack(rawQuery);
    const startMs =
      input.sinceIso && Number.isFinite(Date.parse(input.sinceIso))
        ? Date.parse(input.sinceIso)
        : nowMs - Math.max(1, daysBack) * DAY_MS;
    const endMs =
      input.untilIso && Number.isFinite(Date.parse(input.untilIso))
        ? Date.parse(input.untilIso)
        : nowMs + 60_000;

    const turns: InternalTurn[] = [];
    let seqCounter = 0;

    const db = this.resolveDb();
    if (db && channelFilter !== "web_ui") {
      try {
        const ownerInfo = ownerOnly ? this.resolveOwnerPeers(db) : { hasAnyOwnerConfig: false, allowedByChannel: new Map<string, Set<string>>() };
        const rows = db
          .prepare(
            `SELECT m.id, m.conversation_id, m.role, m.content, m.created_at, c.channel, c.peer_id, c.kind
             FROM messages m
             JOIN conversations c ON c.id = m.conversation_id
             WHERE m.created_at >= ? AND m.created_at <= ?
               AND c.kind != 'group'
               AND m.role IN ('user', 'assistant')
             ORDER BY m.created_at ASC, m.id ASC`,
          )
          .all(startMs, endMs) as Array<{
          id: number;
          conversation_id: string;
          role: TranscriptRole;
          content: string;
          created_at: number;
          channel: string;
          peer_id: string;
          kind: string;
        }>;

        for (const r of rows) {
          if (channelFilter !== "all" && r.channel !== channelFilter) continue;
          if (ownerOnly && r.channel !== "web" && ownerInfo.hasAnyOwnerConfig) {
            const allowedPeers = ownerInfo.allowedByChannel.get(r.channel);
            if (!allowedPeers?.has(r.peer_id)) continue;
          }
          const redacted = redactTranscriptSecrets(r.content);
          if (!redacted.trim()) continue;
          seqCounter += 1;
          turns.push({
            conversationKey: r.conversation_id,
            channel: r.channel,
            peerId: r.peer_id,
            role: r.role,
            content: redacted,
            rawContent: r.content,
            createdAtMs: r.created_at,
            seq: seqCounter,
          });
        }
      } catch {
        // ignore missing tables
      }
    }

    if (channelFilter === "all" || channelFilter === "web" || channelFilter === "web_ui") {
      for (const wt of this.readDirectWebTurns()) {
        if (wt.createdAtMs < startMs || wt.createdAtMs > endMs) continue;
        if (channelFilter !== "all" && wt.channel !== channelFilter && !(channelFilter === "web" && wt.channel === "web_ui")) {
          continue;
        }
        seqCounter += 1;
        turns.push({
          conversationKey: `${wt.channel}:${wt.peerId}`,
          channel: wt.channel,
          peerId: wt.peerId,
          role: wt.role,
          content: wt.content,
          rawContent: wt.content,
          createdAtMs: wt.createdAtMs,
          seq: seqCounter,
        });
      }
    }

    turns.sort((a, b) => a.createdAtMs - b.createdAtMs || a.seq - b.seq);
    const keywords = extractRecallKeywords(rawQuery);

    let matchedTurns: InternalTurn[] = [];
    if (keywords.length === 0) {
      matchedTurns = turns;
    } else {
      const hitIndices = new Set<number>();
      for (let i = 0; i < turns.length; i += 1) {
        const score = scoreTurnAgainstKeywords(turns[i]!.content, keywords);
        if (score > 0) {
          hitIndices.add(i);
          const cur = turns[i]!;
          if (cur.role === "user" && i + 1 < turns.length) {
            const nxt = turns[i + 1]!;
            if (nxt.conversationKey === cur.conversationKey && nxt.role === "assistant" && nxt.createdAtMs - cur.createdAtMs <= PAIR_CONTEXT_MAX_GAP_MS) {
              hitIndices.add(i + 1);
            }
          } else if (cur.role === "assistant" && i - 1 >= 0) {
            const prv = turns[i - 1]!;
            if (prv.conversationKey === cur.conversationKey && prv.role === "user" && cur.createdAtMs - prv.createdAtMs <= PAIR_CONTEXT_MAX_GAP_MS) {
              hitIndices.add(i - 1);
            }
          }
        }
      }
      matchedTurns = Array.from(hitIndices)
        .sort((a, b) => a - b)
        .map((idx) => turns[idx]!);
    }

    const totalMatched = matchedTurns.length;
    const sliced =
      keywords.length === 0
        ? selectTimeBrowseSlice(matchedTurns, limit, rawQuery, nowMs)
        : matchedTurns.slice(-limit);

    const channelsCovered = Array.from(new Set(matchedTurns.map((t) => t.channel)));
    const items: ChatHistoryRecallItem[] = sliced.map((t) => {
      const iso = new Date(t.createdAtMs).toISOString();
      return {
        atIso: iso,
        dateKey: iso.slice(0, 10),
        channel: t.channel,
        role: t.role,
        snippet: clipSnippet(t.content),
      };
    });

    return {
      ok: true,
      windowStartIso: new Date(startMs).toISOString(),
      windowEndIso: new Date(endMs).toISOString(),
      totalMatched,
      channelsCovered,
      items,
    };
  }
}
