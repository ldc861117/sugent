import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildEpisodeAnchorId,
  ChatTranscriptRecallService,
} from "../src/sugent/chat-transcript-recall.js";
import {
  AtlasError,
  computeReciprocalRankFusion,
  computeTemporalTrustMultiplier,
  cosineSimilarity,
  decodeFloat32Blob,
  encodeFloat32Blob,
  expandSearchSynonyms,
  SOURCE_TRUST_WEIGHT,
  StereoscopicAtlas,
  STRATUM_HALF_LIFE_DAYS,
  SYNONYM_CLUSTERS,
  tokenizeForSearch,
  type AtlasEdge,
  type AtlasNode,
} from "../src/sugent/stereoscopic-atlas.js";

const tempDirs: string[] = [];
const openAtlases: StereoscopicAtlas[] = [];
const openDbs: DatabaseSync[] = [];

function makeTempDir(prefix = "sugent-p5-lane-b-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createSeededHostDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  openDbs.push(db);
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
  while (openAtlases.length > 0) {
    openAtlases.pop()?.close();
  }
  while (openDbs.length > 0) {
    try {
      openDbs.pop()?.close();
    } catch {
      /* ignore already closed */
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Wave P5.2 (Lane B): Hybrid Synonym/Vector RRF, Temporal Half-Life & S0->S3 Provenance", () => {
  it("expands bilingual domain synonyms & abbreviations + CJK trigrams without false ASCII substring triggers", () => {
    expect(SYNONYM_CLUSTERS.length).toBeGreaterThanOrEqual(12);

    const paymentExpanded = expandSearchSynonyms(["net", "60"], "客户要求 Net 60 信用期");
    expect(paymentExpanded).toEqual(expect.arrayContaining(["net60", "账期", "净账期", "信用期", "付款周期"]));

    const redlineExpanded = expandSearchSynonyms(["guardrail"]);
    expect(redlineExpanded).toEqual(expect.arrayContaining(["红线", "底线", "禁忌"]));

    const e2eExpanded = expandSearchSynonyms(["e2e"]);
    expect(e2eExpanded).toEqual(expect.arrayContaining(["联调", "集成验证", "integration"]));

    const deployExpanded = expandSearchSynonyms(["热更"], "直接热更容器");
    expect(deployExpanded).toEqual(expect.arrayContaining(["部署", "热更新", "rollout", "deploy"]));

    const crunchExpanded = tokenizeForSearch("熬夜赶工高压");
    expect(crunchExpanded).toEqual(expect.arrayContaining(["熬夜赶", "夜赶工", "高负荷", "overloaded", "压缩期"]));

    // Ensure "Sonnet" does NOT falsely trigger the "net" -> "账期" synonym cluster
    const sonnetTokens = tokenizeForSearch("Claude Sonnet 4.5");
    expect(sonnetTokens).not.toContain("账期");

    const atlas = new StereoscopicAtlas(":memory:");
    openAtlases.push(atlas);
    atlas.applyDelta(
      {
        nodes: [
          {
            id: "contract:payment-rule",
            plane: "domain_work:contract-guard",
            stratum: "crystallized_wisdom",
            kind: "guardrail",
            name: "合同结算账期护栏",
            summary: "所有定制开发合同账期最长不超过30天，拒绝长周期垫资",
            tags: ["contract"],
          },
          {
            id: "contract:floor-rule",
            plane: "owner_life",
            stratum: "crystallized_wisdom",
            kind: "guardrail",
            name: "年度顾问报价红线",
            summary: "年度架构顾问报价红线 48 万人民币",
            tags: ["pricing"],
          },
          {
            id: "ops:integration-sop",
            plane: "domain_work:sugent",
            stratum: "verified_fact",
            kind: "workflow",
            name: "跨仓联调标准流程",
            summary: "前后端联调必须跑通契约校验脚本",
            tags: ["sop"],
          },
          {
            id: "ops:deploy-tombstone",
            plane: "self_core",
            stratum: "crystallized_wisdom",
            kind: "tombstone",
            name: "生产部署墓碑",
            summary: "严禁周五下班前未过门禁直接上线部署",
            tags: ["ops"],
          },
          {
            id: "duo:overload-anchor",
            plane: "self_core",
            stratum: "digested_state",
            kind: "concept",
            name: "高负荷窗口调频",
            summary: "主理人高负荷期优先发送三行安心信号，暂缓复杂复盘",
            tags: ["duo"],
          },
        ],
      },
      "2026-11-28T10:00:00.000Z",
    );

    expect(atlas.recallStereoscopic("Net 60 信用期").nodes[0]?.id).toBe("contract:payment-rule");
    expect(atlas.recallStereoscopic("报价底线 guardrail").nodes[0]?.id).toBe("contract:floor-rule");
    expect(atlas.recallStereoscopic("e2e 集成验证").nodes[0]?.id).toBe("ops:integration-sop");
    expect(atlas.recallStereoscopic("热更 rollout 踩坑").nodes[0]?.id).toBe("ops:deploy-tombstone");
    expect(atlas.recallStereoscopic("熬夜赶工 overloaded").nodes[0]?.id).toBe("duo:overload-anchor");
  });

  it("persists SQLite atlas_embeddings BLOBs, rescues zero-overlap paraphrases via RRF (k=60), and degrades cleanly offline", async () => {
    const rawVec = [0.6, -0.8, 0.0, 0.25];
    const blob = encodeFloat32Blob(rawVec);
    // Slice at unaligned offset to verify alignment-safe decoding
    const padded = new Uint8Array(blob.byteLength + 3);
    padded.set(blob, 1);
    const decoded = decodeFloat32Blob(padded.subarray(1, 1 + blob.byteLength));
    expect(decoded).toHaveLength(4);
    expect(decoded[0]).toBeCloseTo(0.6, 5);
    expect(decoded[1]).toBeCloseTo(-0.8, 5);
    expect(cosineSimilarity(decoded, rawVec)).toBeCloseTo(1.0, 5);

    const rrf = computeReciprocalRankFusion(
      [
        ["node:a", "node:b", "node:c"],
        ["node:c", "node:a"],
      ],
      60,
    );
    expect(rrf.get("node:a")).toBeCloseTo(1 / 61 + 1 / 62, 8);
    expect(rrf.get("node:c")).toBeCloseTo(1 / 63 + 1 / 61, 8);
    expect(rrf.get("node:b")).toBeCloseTo(1 / 62, 8);

    const dir = makeTempDir("sugent-rrf-vec-");
    const semanticMap = new Map<string, number[]>([
      ["流动性缓冲安全垫", [0.96, 0.28, 0.0, 0.0]],
      ["公司账上必须常备18个月以上极端断粮期现金储备", [0.95, 0.31, 0.0, 0.0]],
      ["日常前端CSS圆角间距微调记录", [0.0, 0.0, 0.98, 0.2]],
      ["废弃旧版缓冲备忘", [0.92, 0.35, 0.0, 0.0]],
    ]);

    const resolveFakeVec = (text: string): number[] => {
      for (const [key, vec] of semanticMap.entries()) {
        if (text.includes(key)) return vec;
      }
      return [0.0, 0.0, 0.1, 0.99];
    };

    const atlas1 = new StereoscopicAtlas(dir);
    openAtlases.push(atlas1);
    atlas1.applyDelta(
      {
        nodes: [
          {
            id: "fin:runway-reserve",
            plane: "owner_life",
            stratum: "crystallized_wisdom",
            kind: "guardrail",
            name: "极端断粮期储备铁律",
            summary: "公司账上必须常备18个月以上极端断粮期现金储备",
            tags: ["runway"],
          },
          {
            id: "ui:css-padding",
            plane: "domain_work:sugent",
            stratum: "verified_fact",
            kind: "concept",
            name: "界面圆角微调",
            summary: "日常前端CSS圆角间距微调记录",
            tags: ["css"],
          },
          {
            id: "fin:obsolete",
            plane: "owner_life",
            stratum: "verified_fact",
            kind: "concept",
            name: "旧备忘",
            summary: "废弃旧版缓冲备忘",
            tags: ["old"],
          },
        ],
      },
      "2026-11-28T10:00:00.000Z",
    );

    // Without embeddings, pure semantic paraphrase with zero character overlap misses fin:runway-reserve
    const lexicalOnly = atlas1.recallStereoscopic("流动性缓冲安全垫");
    expect(lexicalOnly.nodes.map((n) => n.id)).not.toContain("fin:runway-reserve");

    // Batch-index missing embeddings into SQLite BLOB table
    atlas1.attachEmbeddingPort({
      modelId: "mock-dim4-v1",
      embedBatch: async (texts) => texts.map((t) => resolveFakeVec(t)),
    });
    const indexed = await atlas1.indexMissingEmbeddings();
    expect(indexed.indexed).toBe(3);
    expect(atlas1.getNodeEmbedding("fin:runway-reserve")?.modelId).toBe("mock-dim4-v1");

    // Superseding a node must purge its stale row from atlas_embeddings
    atlas1.supersedeNode("fin:obsolete", "fin:runway-reserve", "2026-11-28T11:00:00.000Z");
    expect(atlas1.getNodeEmbedding("fin:obsolete")).toBeUndefined();
    atlas1.close();
    openAtlases.pop();

    // Reopen from disk and verify SQLite BLOB persisted and rescues the zero-overlap semantic query
    const atlas2 = new StereoscopicAtlas(dir, {
      embeddingPort: {
        modelId: "mock-dim4-v1",
        embedSync: (q) => resolveFakeVec(q),
      },
    });
    openAtlases.push(atlas2);
    expect(atlas2.getNodeEmbedding("fin:runway-reserve")?.dim).toBe(4);
    expect(atlas2.getNodeEmbedding("fin:obsolete")).toBeUndefined();

    const hybridRescued = atlas2.recallStereoscopic("流动性缓冲安全垫", { maxNodes: 5 });
    expect(hybridRescued.nodes[0]?.id).toBe("fin:runway-reserve");

    // Offline mode ("none"): throwing embedding port must never break lexical/synonym recall
    atlas2.attachEmbeddingPort({
      modelId: "offline-broken",
      embedSync: () => {
        throw new Error("ECONNREFUSED: offline mode:none");
      },
      embedBatch: async () => {
        throw new Error("ECONNREFUSED: offline mode:none");
      },
    });
    const offlineFallback = atlas2.recallStereoscopic("18个月 现金储备");
    expect(offlineFallback.nodes[0]?.id).toBe("fin:runway-reserve");
    await expect(atlas2.indexMissingEmbeddings()).resolves.toEqual({ indexed: 0 });
  });

  it("applies stratum half-life temporal decay and sourceTrust weighting accurately", () => {
    expect(STRATUM_HALF_LIFE_DAYS).toEqual({
      raw_episodic: 14,
      digested_state: 60,
      verified_fact: 90,
      crystallized_wisdom: 3650,
    });
    expect(SOURCE_TRUST_WEIGHT.owner_confirmed).toBeGreaterThan(SOURCE_TRUST_WEIGHT.llm_inferred!);

    const nowIso = "2026-11-28T00:00:00.000Z";
    const refMs = Date.parse(nowIso);
    const sixtyDaysAgoIso = new Date(refMs - 60 * 86_400_000).toISOString();

    const rawMult = computeTemporalTrustMultiplier(
      {
        stratum: "raw_episodic",
        kind: "concept",
        sourceTrust: "owner_confirmed",
        reinforcements: 1,
        updatedAt: sixtyDaysAgoIso,
      },
      refMs,
    );
    const wisdomMult = computeTemporalTrustMultiplier(
      {
        stratum: "crystallized_wisdom",
        kind: "tombstone",
        sourceTrust: "owner_confirmed",
        reinforcements: 1,
        updatedAt: sixtyDaysAgoIso,
      },
      refMs,
    );
    // 60 days = >4 half-lives for raw_episodic (~5.1% left), vs ~98.9% left for 3650d tombstone
    expect(wisdomMult / rawMult).toBeGreaterThan(35);

    const atlas = new StereoscopicAtlas(":memory:");
    openAtlases.push(atlas);

    atlas.applyDelta(
      {
        nodes: [
          {
            id: "raw:old-incident",
            plane: "domain_work:sugent",
            stratum: "raw_episodic",
            kind: "concept",
            name: "数据库迁移偶发抖动记录",
            summary: "六十天前一次数据库迁移偶发超时日志记录",
            tags: ["db-migration"],
            sourceTrust: "owner_confirmed",
            reinforcements: 1,
          },
          {
            id: "tomb:db-lock",
            plane: "self_core",
            stratum: "crystallized_wisdom",
            kind: "tombstone",
            name: "数据库迁移锁表墓碑",
            summary: "数据库迁移严禁在高峰期直接跑全表索引重建日志记录",
            tags: ["db-migration"],
            sourceTrust: "owner_confirmed",
            reinforcements: 1,
          },
          {
            id: "fact:inferred-sla",
            plane: "domain_work:contract-guard",
            stratum: "verified_fact",
            kind: "concept",
            name: "SLA 响应承诺准则",
            summary: "紧急故障 SLA 响应目标为 30 分钟内介入",
            tags: ["sla"],
            sourceTrust: "llm_inferred",
            reinforcements: 1,
          },
          {
            id: "fact:confirmed-sla",
            plane: "domain_work:contract-guard",
            stratum: "verified_fact",
            kind: "concept",
            name: "SLA 响应承诺准则",
            summary: "紧急故障 SLA 响应目标为 30 分钟内介入",
            tags: ["sla"],
            sourceTrust: "owner_confirmed",
            reinforcements: 1,
          },
        ],
      },
      sixtyDaysAgoIso,
    );

    const decayedRecall = atlas.recallStereoscopic("数据库迁移 日志记录", { nowIso });
    expect(decayedRecall.nodes[0]?.id).toBe("tomb:db-lock");

    const trustTieBreak = atlas.recallStereoscopic("紧急故障 SLA 响应目标", { nowIso });
    expect(trustTieBreak.nodes[0]?.id).toBe("fact:confirmed-sla");
    expect(trustTieBreak.nodes[1]?.id).toBe("fact:inferred-sla");
  });

  it("imports lossless snapshots preserving supersededAt, supersededBy, archivedAt, and membranePolicy across DB reopen", () => {
    const dir = makeTempDir("sugent-lossless-snap-");
    const snapshotNodes: AtlasNode[] = [
      {
        id: "proj:old-v1",
        plane: "domain_work:sugent",
        stratum: "verified_fact",
        kind: "tool",
        name: "Legacy Polling Store",
        summary: "旧版轮询存储实现方案",
        tags: ["storage"],
        principalAcl: ["sugent_self", "owner:M"],
        reinforcements: 2,
        confidence: 0.85,
        sourceTrust: "legacy_import",
        updatedAt: "2026-11-20T09:00:00.000Z",
        supersededAt: "2026-11-25T10:00:00.000Z",
        supersededBy: "proj:new-v2",
      },
      {
        id: "proj:new-v2",
        plane: "domain_work:sugent",
        stratum: "crystallized_wisdom",
        kind: "canon",
        name: "SQLite WAL Native Atlas",
        summary: "原生单一立体图谱存储架构",
        tags: ["storage", "sqlite"],
        principalAcl: ["sugent_self", "owner:M"],
        reinforcements: 5,
        confidence: 0.98,
        sourceTrust: "owner_confirmed",
        steps: ["initSchema", "importLosslessSnapshot"],
        skillGateStatus: "approved",
        updatedAt: "2026-11-25T10:00:00.000Z",
      },
      {
        id: "sim:expired-hyp",
        plane: "meta_evolution",
        stratum: "raw_episodic",
        kind: "hypothesis",
        name: "Expired Sandbox Hypothesis",
        summary: "超7天未验证已归档的实验假说",
        tags: ["sandbox"],
        principalAcl: ["sugent_self", "owner:M"],
        reinforcements: 1,
        confidence: 0.4,
        sourceTrust: "llm_inferred",
        updatedAt: "2026-11-22T08:00:00.000Z",
        archivedAt: "2026-11-28T00:00:00.000Z",
      },
      {
        id: "duo:weather:cap1",
        plane: "relational:duo-andy-gillna",
        stratum: "digested_state",
        kind: "capsule",
        name: "Calm Evening Capsule",
        summary: "双人平缓恢复天气胶囊",
        tags: ["capsule"],
        principalAcl: ["sugent_self", "owner:M", "partner:W"],
        reinforcements: 3,
        confidence: 0.9,
        sourceTrust: "mutual_endorsed",
        updatedAt: "2026-11-27T18:00:00.000Z",
      },
    ];

    const snapshotEdges: AtlasEdge[] = [
      {
        id: "proj:new-v2--projects_to-->duo:weather:cap1",
        plane: "domain_work:sugent",
        from: "proj:new-v2",
        relation: "projects_to",
        to: "duo:weather:cap1",
        weight: 0.9,
        source: "membrane:M1",
        isMembraneEdge: true,
        membranePolicy: "M1_delexicalized_strict",
        principalAcl: ["sugent_self", "owner:M", "partner:W"],
        validFrom: "2026-11-27T18:00:00.000Z",
        updatedAt: "2026-11-27T18:00:00.000Z",
      },
    ];

    const atlas1 = new StereoscopicAtlas(dir);
    const importRes = atlas1.importLosslessSnapshot({ nodes: snapshotNodes, edges: snapshotEdges });
    expect(importRes).toEqual({ importedNodes: 4, importedEdges: 1 });
    atlas1.close();

    const atlas2 = new StereoscopicAtlas(dir);
    openAtlases.push(atlas2);

    const oldNode = atlas2.getNode("proj:old-v1");
    expect(oldNode?.supersededAt).toBe("2026-11-25T10:00:00.000Z");
    expect(oldNode?.supersededBy).toBe("proj:new-v2");

    const archivedNode = atlas2.getNode("sim:expired-hyp");
    expect(archivedNode?.archivedAt).toBe("2026-11-28T00:00:00.000Z");

    const newNode = atlas2.getNode("proj:new-v2");
    expect(newNode?.sourceTrust).toBe("owner_confirmed");
    expect(newNode?.skillGateStatus).toBe("approved");
    expect(newNode?.steps).toEqual(["initSchema", "importLosslessSnapshot"]);

    const membraneEdge = atlas2.getEdge("proj:new-v2--projects_to-->duo:weather:cap1");
    expect(membraneEdge?.isMembraneEdge).toBe(true);
    expect(membraneEdge?.membranePolicy).toBe("M1_delexicalized_strict");

    // Zero zombie recall on superseded or archived nodes
    expect(atlas2.recallStereoscopic("轮询").nodes).toHaveLength(0);
    expect(atlas2.recallStereoscopic("轮询存储").nodes.map((n) => n.id)).not.toContain("proj:old-v1");
    expect(atlas2.recallStereoscopic("实验假说").nodes).toHaveLength(0);
    expect(atlas2.recallStereoscopic("轮询", { includeSuperseded: true }).nodes.map((n) => n.id)).toContain(
      "proj:old-v1",
    );
    expect(atlas2.recallStereoscopic("立体图谱").nodes.map((n) => n.id)).toContain("proj:new-v2");
  });

  it("traces S0 -> S3 episode provenance for owner:M across WeChat & Web turns while strictly blocking partner:W and peer:client", () => {
    const dataDir = makeTempDir("sugent-provenance-");
    const hostDb = createSeededHostDb(path.join(dataDir, "anymodel.db"));

    const wxTs = Date.parse("2026-11-20T14:30:00.000Z");
    const webTs = Date.parse("2026-11-22T09:15:00.000Z");
    const secretSample = ["sk", "liveSecretKeyForProvenanceTest99"].join("-");

    hostDb
      .prepare("INSERT INTO weixin_accounts VALUES ('default', 'tok', 'ilink', 'https://u', 'wx-owner-m', '', 0, ?)")
      .run(wxTs);
    hostDb
      .prepare("INSERT INTO conversations VALUES ('conv-owner-wx', 'default', 'weixin', 'wx-owner-m', 'Owner', '', 'dm', 'default', ?, ?)")
      .run(wxTs, wxTs + 10_000);
    hostDb
      .prepare("INSERT INTO conversations VALUES ('conv-stranger-wx', 'default', 'weixin', 'wx-peer-client', 'Client', '', 'dm', 'default', ?, ?)")
      .run(wxTs, wxTs + 10_000);

    const wxUserContent = `跟宏远集团签合同时记住：违约连带责任绝对不能签，顺便旧测试key ${secretSample} 作废`;
    const wxAssistantContent = "明白，已记录宏远集团合同红线：严禁接受无限连带违约条款。";
    hostDb
      .prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)")
      .run("conv-owner-wx", "user", wxUserContent, wxTs);
    hostDb
      .prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)")
      .run("conv-owner-wx", "assistant", wxAssistantContent, wxTs + 4_000);
    hostDb
      .prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)")
      .run("conv-stranger-wx", "user", "我是外部客户违约条款询价", wxTs + 2_000);

    const chatRecall = new ChatTranscriptRecallService({
      dataDir,
      db: hostDb,
      nowMs: () => Date.parse("2026-11-28T12:00:00.000Z"),
    });

    const wxEpisodeId = buildEpisodeAnchorId({
      channel: "weixin",
      createdAtMs: wxTs,
      content: wxUserContent,
    });
    const expectedHash8 = crypto.createHash("sha256").update(wxUserContent, "utf8").digest("hex").slice(0, 8);
    expect(wxEpisodeId).toBe(`ep:weixin:${wxTs}:${expectedHash8}`);

    const webUserContent = "网页端补充一条：宏远集团首付款比例不得低于 40%";
    const webRec = chatRecall.recordDirectStewardTurn({
      channel: "web_ui",
      role: "user",
      content: webUserContent,
      createdAtMs: webTs,
    });
    chatRecall.recordDirectStewardTurn({
      channel: "web_ui",
      role: "assistant",
      content: "已补充宏远集团首付 >= 40% 条款护栏。",
      createdAtMs: webTs + 3_000,
    });
    expect(webRec.recorded).toBe(true);
    expect(webRec.episodeId).toBe(
      buildEpisodeAnchorId({ channel: "web_ui", createdAtMs: webTs, content: webUserContent }),
    );

    const atlas = new StereoscopicAtlas(path.join(dataDir, "atlas"));
    openAtlases.push(atlas);

    // Seed S0 episode anchors in owner_life + S1 verified_fact + S3 crystallized_wisdom in domain_work:contract-guard
    atlas.applyDelta(
      {
        nodes: [
          {
            id: wxEpisodeId,
            plane: "owner_life",
            stratum: "raw_episodic",
            kind: "episode_anchor",
            name: "WeChat 原话锚点",
            summary: "宏远集团合同严禁接受违约连带责任",
            tags: ["channel:weixin", `at:${new Date(wxTs).toISOString()}`, "episode_anchor"],
            principalAcl: ["owner:M"],
          },
          {
            id: webRec.episodeId!,
            plane: "owner_life",
            stratum: "raw_episodic",
            kind: "episode_anchor",
            name: "Web 原话锚点",
            summary: "宏远集团首付款比例不低于40%",
            tags: ["channel:web_ui", `at:${new Date(webTs).toISOString()}`, "episode_anchor"],
            principalAcl: ["owner:M"],
          },
          {
            id: "fact:hongyuan-liability-v1",
            plane: "domain_work:contract-guard",
            stratum: "verified_fact",
            kind: "guardrail",
            name: "宏远违约责任条款 v1",
            summary: "拒绝连带违约赔付条款",
            principalAcl: ["sugent_self", "owner:M"],
          },
          {
            id: "crystal:hongyuan-contract-canon",
            plane: "domain_work:contract-guard",
            stratum: "crystallized_wisdom",
            kind: "canon",
            name: "宏远集团商务签约总纲 (S3)",
            summary: "严禁连带违约毒丸条款，且首付款必须 >= 40%",
            principalAcl: ["sugent_self", "owner:M"],
          },
        ],
        edges: [
          // Cross-plane S1 -> S0 provenance edge strictly scoped to ["owner:M"] is allowed!
          {
            from: "fact:hongyuan-liability-v1",
            relation: "derived_from_episode",
            to: wxEpisodeId,
            source: "post_turn_digester",
            principalAcl: ["owner:M"],
          },
          {
            from: "crystal:hongyuan-contract-canon",
            relation: "synthesized_from",
            to: "fact:hongyuan-liability-v1",
            source: "memory_gardener",
            principalAcl: ["owner:M"],
          },
          {
            from: "crystal:hongyuan-contract-canon",
            relation: "derived_from_episode",
            to: webRec.episodeId!,
            source: "post_turn_digester",
            principalAcl: ["owner:M"],
          },
        ],
      },
      "2026-11-28T10:00:00.000Z",
    );

    // Non-owner ACL or isMembraneEdge:true on raw_episodic MUST still be rejected
    expect(() =>
      atlas.applyDelta({
        edges: [
          {
            from: "crystal:hongyuan-contract-canon",
            relation: "derived_from_episode",
            to: wxEpisodeId,
            source: "bad_acl",
            principalAcl: ["owner:M", "partner:W"],
          },
        ],
      }),
    ).toThrowError(AtlasError);

    expect(() =>
      atlas.applyDelta({
        edges: [
          {
            from: "crystal:hongyuan-contract-canon",
            relation: "derived_from_episode",
            to: wxEpisodeId,
            source: "bad_membrane",
            isMembraneEdge: true,
            principalAcl: ["owner:M"],
          },
        ],
      }),
    ).toThrowError(/ATLAS_RAW_MEMBRANE_FORBIDDEN/);

    // owner:M drills down from S3 crystal all the way to S0 WeChat & Web dialogue turns
    const ownerTrace = atlas.traceEpisodeProvenance("crystal:hongyuan-contract-canon", {
      callerPrincipals: ["owner:M", "sugent_self"],
      lookupTranscript: (hint) =>
        chatRecall.lookupEpisodeContext({
          episodeId: hint.episodeId,
          atIso: hint.atIso,
          channel: (hint.channel as "weixin" | "web_ui" | undefined) ?? "all",
          queryHint: hint.summary,
          callerPrincipal: "owner:M",
        }).items,
    });

    expect(ownerTrace.allowed).toBe(true);
    expect(ownerTrace.episodeNodes.map((n) => n.id)).toEqual(
      expect.arrayContaining([wxEpisodeId, webRec.episodeId!]),
    );
    // Both user and paired assistant turns across WeChat + Web are recovered, secrets redacted, stranger excluded
    expect(ownerTrace.transcriptSnippets.length).toBeGreaterThanOrEqual(4);
    const joinedSnippets = ownerTrace.transcriptSnippets.map((s) => s.snippet).join("\n");
    expect(joinedSnippets).toContain("违约连带责任绝对不能签");
    expect(joinedSnippets).toContain("严禁接受无限连带违约条款");
    expect(joinedSnippets).toContain("首付款比例不得低于 40%");
    expect(joinedSnippets).toContain("[REDACTED_KEY]");
    expect(joinedSnippets).not.toContain(secretSample);
    expect(joinedSnippets).not.toContain("外部客户违约条款询价");

    // Window-based lookup without exact episodeId also works for owner:M
    const windowLookup = chatRecall.lookupEpisodeContext({
      atIso: new Date(wxTs + 60_000).toISOString(),
      channel: "weixin",
      queryHint: "宏远集团 违约",
      windowMinutes: 15,
      callerPrincipal: "owner:M",
    });
    expect(windowLookup.allowed).toBe(true);
    expect(windowLookup.items.some((i) => i.snippet.includes("宏远集团"))).toBe(true);

    // partner:W and peer:client MUST receive allowed: false and zero snippets on both Atlas & ChatTranscriptRecall
    for (const blockedPrincipal of ["partner:W", "peer:client", "public"] as const) {
      const deniedTrace = atlas.traceEpisodeProvenance("crystal:hongyuan-contract-canon", {
        callerPrincipals: [blockedPrincipal],
        lookupTranscript: () => {
          throw new Error("lookupTranscript must never be invoked for non-owner principals");
        },
      });
      expect(deniedTrace).toEqual({
        allowed: false,
        errorCode: "PROVENANCE_OWNER_ONLY",
        chain: [],
        episodeNodes: [],
        transcriptSnippets: [],
      });

      const deniedLookup = chatRecall.lookupEpisodeContext({
        episodeId: wxEpisodeId,
        callerPrincipal: blockedPrincipal,
      });
      expect(deniedLookup).toEqual({ allowed: false, items: [] });
    }
  });
});
