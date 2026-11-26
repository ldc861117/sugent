import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  ChatTranscriptRecallService,
  redactTranscriptSecrets,
} from "../src/sugent/chat-transcript-recall.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createSeededDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, channel TEXT NOT NULL, peer_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'dm',
      account TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS weixin_accounts (
      bot_id TEXT PRIMARY KEY, bot_token TEXT NOT NULL, ilink_bot_id TEXT NOT NULL, base_url TEXT NOT NULL,
      owner_user_id TEXT NOT NULL DEFAULT '', cursor TEXT NOT NULL DEFAULT '', paused_until INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS access (
      id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, channel TEXT NOT NULL, peer_id TEXT NOT NULL,
      sender_id TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT '', code TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '',
      requests INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      decided_at INTEGER NOT NULL DEFAULT 0, decided_by TEXT NOT NULL DEFAULT '',
      replied_at INTEGER NOT NULL DEFAULT 0, notified_at INTEGER NOT NULL DEFAULT 0);
  `);
  return db;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Sugent ChatTranscriptRecallService & redactTranscriptSecrets", () => {
  it("redacts API keys, bearer tokens, and URL query tokens without mangling normal text", () => {
    const sampleKey = ["sk", "demo1234567890"].join("-");
    const sampleBearer = ["tok", "demobearer987654"].join("-");
    const sampleUrlTok = "demotokenvalue123456";
    const raw = `网关秘钥 ${sampleKey} 与 Bearer ${sampleBearer}，链接 https://example.invalid/?token=${sampleUrlTok} 正常文本保留`;
    const cleaned = redactTranscriptSecrets(raw);
    expect(cleaned).not.toContain(sampleKey);
    expect(cleaned).not.toContain(sampleBearer);
    expect(cleaned).not.toContain(sampleUrlTok);
    expect(cleaned).toContain("[REDACTED_KEY]");
    expect(cleaned).toContain("?token=[REDACTED]");
    expect(cleaned).toContain("正常文本保留");
  });

  it("hydrates cold-start peer history in chronological order starting with user and excluding group/stranger noise", () => {
    const dataDir = makeTempDir("sugent-recall-hydrate-");
    const db = createSeededDb(path.join(dataDir, "anymodel.db"));
    try {
      const t0 = Date.parse("2026-11-24T10:00:00Z");
      const sampleKey = ["sk", "testkey99999999"].join("-");
      db.prepare("INSERT INTO weixin_accounts VALUES (?, ?, ?, ?, ?, '', 0, ?)").run(
        "default",
        "wx-bot-tok",
        "ilink-1",
        "https://ilink",
        "wx-owner-1",
        t0,
      );
      db.prepare("INSERT INTO conversations VALUES (?, 'default', 'weixin', 'wx-owner-1', 'Owner', '', 'dm', 'default', ?, ?)").run(
        "conv-wx-owner",
        t0,
        t0 + 5000,
      );
      db.prepare("INSERT INTO conversations VALUES (?, 'default', 'weixin', 'wx-group-1', 'Group', '', 'group', 'default', ?, ?)").run(
        "conv-wx-group",
        t0,
        t0 + 5000,
      );

      db.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)").run(
        "conv-wx-owner",
        "assistant",
        "上次重启恢复通知",
        t0 + 100,
      );
      db.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)").run(
        "conv-wx-owner",
        "user",
        `帮我记一下 AirToken 网关凭证是 ${sampleKey}`,
        t0 + 1000,
      );
      db.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)").run(
        "conv-wx-owner",
        "assistant",
        "已记下 AirToken 网关配置。",
        t0 + 2000,
      );
      db.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)").run(
        "conv-wx-group",
        "user",
        "群聊无关噪声",
        t0 + 3000,
      );

      const svc = new ChatTranscriptRecallService({ dataDir, db, nowMs: () => t0 + 86_400_000 });
      const hydrated = svc.hydrateRecentPeerHistory({
        channel: "weixin",
        peerId: "wx-owner-1",
        maxMessages: 4,
      });
      expect(hydrated).toHaveLength(2);
      expect(hydrated[0]?.role).toBe("user");
      expect(hydrated[0]?.content).toContain("[REDACTED_KEY]");
      expect(hydrated[0]?.content).not.toContain(sampleKey);
      expect(hydrated[1]?.content).toContain("AirToken");
    } finally {
      db.close();
    }
  });

  it("recalls yesterday's WeChat + Web Jarvis turns for natural queries ('昨天我们聊了什么' / '昨天我没聊了什么你知道吗') and deduplicates JSONL turns", () => {
    const dataDir = makeTempDir("sugent-recall-crossday-");
    const db = createSeededDb(path.join(dataDir, "anymodel.db"));
    try {
      const nowMs = Date.parse("2026-11-25T09:22:00Z");
      const yesterdayMs = nowMs - 26 * 3_600_000;

      db.prepare("INSERT INTO weixin_accounts VALUES ('default', 'tok', 'ilink', 'https://u', 'wx-owner-1', '', 0, ?)").run(nowMs);
      db.prepare("INSERT INTO conversations VALUES ('c-wx', 'default', 'weixin', 'wx-owner-1', 'Owner', '', 'dm', 'default', ?, ?)").run(
        yesterdayMs,
        nowMs,
      );
      db.prepare("INSERT INTO conversations VALUES ('c-stranger', 'default', 'weixin', 'wx-guest-9', 'Guest', '', 'dm', 'default', ?, ?)").run(
        yesterdayMs,
        nowMs,
      );

      db.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)").run(
        "c-wx",
        "user",
        "我们把 Wave P2 的工业 FDE 诊断包和合同红线防漏包定下来推进",
        yesterdayMs,
      );
      db.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)").run(
        "c-wx",
        "assistant",
        "好的，Wave P2 共包含离线韧性、微信 3 秒转发参谋和两大标杆行业武器包。",
        yesterdayMs + 5_000,
      );
      db.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)").run(
        "c-stranger",
        "user",
        "外部访客私信不应混入主理人历史回忆",
        yesterdayMs + 10_000,
      );

      const svc = new ChatTranscriptRecallService({ dataDir, db, nowMs: () => nowMs });
      const rec1 = svc.recordDirectStewardTurn({
        channel: "web_ui",
        role: "user",
        content: "在网页端顺便确认 airtoken 与 Kev 决策校准模型的接口",
        createdAtMs: yesterdayMs + 60_000,
      });
      expect(rec1.recorded).toBe(true);
      expect(fs.statSync(rec1.filePath).mode & 0o777).toBe(0o600);

      const dup = svc.recordDirectStewardTurn({
        channel: "weixin",
        role: "user",
        content: "我们把 Wave P2 的工业 FDE 诊断包和合同红线防漏包定下来推进",
        createdAtMs: yesterdayMs + 500,
      });
      expect(dup.deduplicated).toBe(true);

      const recallTypo = svc.recallChatHistory({
        query: "昨天我没聊了什么你知道吗",
      });
      expect(recallTypo.ok).toBe(true);
      expect(recallTypo.totalMatched).toBeGreaterThanOrEqual(3);
      expect(recallTypo.channelsCovered).toEqual(expect.arrayContaining(["weixin", "web_ui"]));
      const combinedText = recallTypo.items.map((i) => i.snippet).join("\n");
      expect(combinedText).toContain("Wave P2");
      expect(combinedText).toContain("airtoken");
      expect(combinedText).not.toContain("外部访客私信");

      const topicRecall = svc.recallChatHistory({
        query: "airtoken",
        daysBack: 3,
      });
      expect(topicRecall.totalMatched).toBeGreaterThanOrEqual(1);
      expect(topicRecall.items[0]?.snippet).toContain("airtoken");
    } finally {
      db.close();
    }
  });
});
