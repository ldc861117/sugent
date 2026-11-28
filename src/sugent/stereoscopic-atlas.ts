import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { looksSecret } from "../agent/memory.js";
import type { EntityKind, KGDelta, SkillGateStatus, SugentKnowledgeGraph } from "./knowledge-graph.js";

export type GraphPlaneId =
  | "self_core"
  | "owner_life"
  | `relational:${string}`
  | `domain_work:${string}`
  | "meta_evolution";

export type EpistemicStratum =
  | "raw_episodic"
  | "verified_fact"
  | "digested_state"
  | "crystallized_wisdom";

export type PrincipalId =
  | "sugent_self"
  | "owner:M"
  | `partner:${string}`
  | `co_owned:${string}`
  | `peer:${string}`
  | "public";

export type SourceTrust =
  | "owner_confirmed"
  | "mutual_endorsed"
  | "deterministic_gate"
  | "llm_inferred"
  | "legacy_import"
  | (string & {});

export type AtlasNodeKind = EntityKind | "commitment" | "guardrail" | "hypothesis" | "capsule" | "tombstone" | "canon" | (string & {});

export type AtlasErrorCode = "ATLAS_SECRET_REJECTED" | "ATLAS_RAW_MEMBRANE_FORBIDDEN";

export class AtlasError extends Error {
  constructor(
    readonly code: AtlasErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "AtlasError";
  }
}

export interface AtlasNode {
  id: string;
  plane: GraphPlaneId;
  stratum: EpistemicStratum;
  kind: AtlasNodeKind;
  name: string;
  summary: string;
  tags: string[];
  principalAcl: PrincipalId[];
  reinforcements: number;
  confidence: number;
  sourceTrust: SourceTrust;
  steps?: string[];
  skillGateStatus?: SkillGateStatus;
  updatedAt: string;
  supersededAt?: string;
  supersededBy?: string;
  archivedAt?: string;
}

export interface AtlasEdge {
  id: string;
  plane: GraphPlaneId;
  from: string;
  relation: string;
  to: string;
  weight: number;
  source: string;
  isMembraneEdge?: boolean;
  membranePolicy?: string;
  principalAcl?: PrincipalId[];
  validFrom: string;
  updatedAt: string;
  supersededAt?: string;
}

export interface AtlasNodeInput {
  id: string;
  plane: GraphPlaneId;
  stratum?: EpistemicStratum;
  kind: AtlasNodeKind;
  name: string;
  summary: string;
  tags?: string[];
  principalAcl?: PrincipalId[];
  reinforcements?: number;
  confidence?: number;
  sourceTrust?: SourceTrust;
  steps?: string[];
  skillGateStatus?: SkillGateStatus;
  archivedAt?: string;
}

export interface AtlasEdgeInput {
  plane?: GraphPlaneId;
  from: string;
  relation: string;
  to: string;
  weight?: number;
  source: string;
  exclusive?: boolean;
  supersedeNodeId?: string;
  isMembraneEdge?: boolean;
  membranePolicy?: string;
  principalAcl?: PrincipalId[];
}

export interface AtlasDelta {
  nodes?: AtlasNodeInput[];
  edges?: AtlasEdgeInput[];
}

export interface AtlasEmbeddingPort {
  modelId?: string;
  embedSync?: (text: string) => ArrayLike<number> | undefined;
  embedBatch?: (texts: string[]) => Promise<Array<ArrayLike<number>>>;
}

export interface AtlasRecallOptions {
  planes?: GraphPlaneId[];
  minStratum?: EpistemicStratum;
  callerPrincipals?: PrincipalId[];
  maxHops?: number;
  maxNodes?: number;
  includeSuperseded?: boolean;
  queryVector?: ArrayLike<number>;
  nowIso?: string;
  rrfK?: number;
}

export interface AtlasRecallResult {
  nodes: AtlasNode[];
  edges: AtlasEdge[];
  crossPlaneBridges: AtlasEdge[];
  markdown: string;
}

export interface EpisodeTranscriptSnippet {
  atIso: string;
  channel: string;
  role: string;
  snippet: string;
  episodeId?: string;
}

export interface EpisodeProvenanceLookupHint {
  episodeNodeId: string;
  episodeId?: string;
  channel?: string;
  atIso?: string;
  summary: string;
}

export type EpisodeProvenanceResult =
  | {
      allowed: false;
      errorCode: "PROVENANCE_OWNER_ONLY";
      chain: AtlasNode[];
      episodeNodes: AtlasNode[];
      transcriptSnippets: EpisodeTranscriptSnippet[];
    }
  | {
      allowed: true;
      chain: AtlasNode[];
      episodeNodes: AtlasNode[];
      transcriptSnippets: EpisodeTranscriptSnippet[];
    };

export interface AtlasPlaneSummary {
  totalNodes: number;
  activeNodes: number;
  supersededNodes: number;
  archivedNodes: number;
  totalEdges: number;
  activeEdges: number;
  supersededEdges: number;
  membraneBridgeCount: number;
  byPlane: Record<
    string,
    { totalNodes: number; activeNodes: number; supersededNodes: number; activeEdges: number }
  >;
  byStratum: Record<EpistemicStratum, number>;
}

const STRATUM_RANK: Record<EpistemicStratum, number> = {
  raw_episodic: 0,
  verified_fact: 1,
  digested_state: 2,
  crystallized_wisdom: 3,
};

const STRATUM_WEIGHT: Record<EpistemicStratum, number> = {
  raw_episodic: 0.6,
  verified_fact: 1.0,
  digested_state: 1.15,
  crystallized_wisdom: 1.35,
};

export const STRATUM_HALF_LIFE_DAYS: Record<EpistemicStratum, number> = {
  raw_episodic: 14,
  digested_state: 60,
  verified_fact: 90,
  crystallized_wisdom: 3650,
};

export const SOURCE_TRUST_WEIGHT: Record<string, number> = {
  owner_confirmed: 1.15,
  mutual_endorsed: 1.12,
  deterministic_gate: 1.08,
  legacy_import: 0.95,
  llm_inferred: 0.92,
};

export function computeTemporalTrustMultiplier(
  node: Pick<AtlasNode, "stratum" | "kind" | "sourceTrust" | "reinforcements" | "updatedAt">,
  refTimeMs: number,
): number {
  const stratumWeight = STRATUM_WEIGHT[node.stratum] ?? 1.0;
  const trustWeight = SOURCE_TRUST_WEIGHT[node.sourceTrust] ?? 1.0;
  const halfLifeDays =
    node.kind === "tombstone"
      ? STRATUM_HALF_LIFE_DAYS.crystallized_wisdom
      : (STRATUM_HALF_LIFE_DAYS[node.stratum] ?? 90);
  const lambda = Math.LN2 / halfLifeDays;
  const nodeMs = Date.parse(node.updatedAt);
  const deltaDays =
    Number.isFinite(nodeMs) && Number.isFinite(refTimeMs)
      ? Math.max(0, (refTimeMs - nodeMs) / 86_400_000)
      : 0;
  const decay = Math.exp(-lambda * deltaDays);
  const reinforcementBoost = 1 + 0.15 * Math.log1p(Math.max(0, node.reinforcements));
  return stratumWeight * trustWeight * decay * reinforcementBoost;
}

export function encodeFloat32Blob(vec: ArrayLike<number>): Uint8Array {
  const f32 = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    const val = Number(vec[i]);
    f32[i] = Number.isFinite(val) ? val : 0;
  }
  return new Uint8Array(f32.buffer.slice(0));
}

export function decodeFloat32Blob(blob: Uint8Array): Float32Array {
  const byteLen = Math.floor(blob.byteLength / 4) * 4;
  if (byteLen === 0) return new Float32Array(0);
  const aligned = new Uint8Array(byteLen);
  aligned.set(blob.subarray(0, byteLen));
  return new Float32Array(aligned.buffer);
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const va = Number(a[i]) || 0;
    const vb = Number(b[i]) || 0;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom <= 1e-12) return 0;
  return dot / denom;
}

export function computeReciprocalRankFusion(
  rankedLists: ReadonlyArray<ReadonlyArray<string>>,
  k = 60,
): Map<string, number> {
  const safeK = Number.isFinite(k) && k > 0 ? k : 60;
  const fused = new Map<string, number>();
  for (const list of rankedLists) {
    const seenInList = new Set<string>();
    let rank = 0;
    for (const id of list) {
      if (!id || seenInList.has(id)) continue;
      seenInList.add(id);
      rank += 1;
      fused.set(id, (fused.get(id) ?? 0) + 1 / (safeK + rank));
    }
  }
  return fused;
}

export const SYNONYM_CLUSTERS: readonly (readonly string[])[] = [
  // Commercial / Contract
  ["账期", "净账期", "信用期", "付款周期", "结算期", "月结", "net", "net30", "net60", "net90", "payment-term"],
  ["红线", "底线", "底价", "禁忌", "雷区", "护栏", "redline", "guardrail", "floor"],
  ["报价", "单价", "总价", "顾问费", "价格", "预算", "quote", "pricing"],
  ["违约", "赔付", "罚则", "连带责任", "无限连带", "毒丸条款", "penalty", "liability"],
  ["首付", "预付款", "启动款", "零首付", "0首付", "downpayment"],
  // Engineering / Ops
  ["联调", "集成验证", "集成测试", "端到端验证", "integration", "e2e"],
  ["部署", "上线", "发布", "热更新", "热更", "热重启", "滚动升级", "deploy", "release", "rollout", "hot-reload"],
  ["门禁", "自检", "校验", "回归检查", "gate", "verify", "typecheck"],
  ["沙盒", "工作树", "隔离环境", "worktree", "sandbox"],
  ["金库", "跨链金库", "双链金库", "vault", "airtoken"],
  ["边车", "无头守护", "辅助容器", "sidecar", "envoy"],
  ["周报", "周度同步", "进展汇总", "weekly", "weekly-sync"],
  // Personal / Duo / Epistemic
  ["高负荷", "过载", "高压", "赶工", "熬夜", "精力透支", "压缩期", "overloaded", "crunch", "burnout"],
  ["伴侣", "双人", "另一半", "爱人", "共处", "留白", "duo", "partner"],
  ["墓碑", "避坑", "踩坑", "翻车", "教训", "证伪", "tombstone", "postmortem"],
  ["沟通", "交流", "汇报", "对谈", "话术", "先给结论", "communication"],
];

const ASCII_ONLY_RE = /^[a-z0-9_.:/-]+$/;

function escapeRegex(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeCompoundShorthands(text: string): string {
  return text
    .toLowerCase()
    .replace(/(^|[^a-z0-9])net\s*(30|60|90)(?=$|[^a-z0-9])/gi, "$1net$2")
    .replace(/0\s*首付/g, "0首付");
}

export function expandSearchSynonyms(tokens: readonly string[], rawText?: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (tok: string) => {
    const clean = tok.trim().toLowerCase();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    out.push(clean);
  };

  const normalizedTokens: string[] = [];
  for (const t of tokens) {
    const norm = normalizeCompoundShorthands(String(t ?? "").trim());
    if (!norm) continue;
    normalizedTokens.push(norm);
    add(norm);
  }
  const tokenSet = new Set<string>(out);
  const rawNorm = rawText ? normalizeCompoundShorthands(rawText) : "";

  for (const cluster of SYNONYM_CLUSTERS) {
    let matched = false;
    for (const syn of cluster) {
      const synLower = syn.toLowerCase();
      if (tokenSet.has(synLower)) {
        matched = true;
        break;
      }
      if (ASCII_ONLY_RE.test(synLower)) {
        if (rawNorm) {
          const boundaryRe = new RegExp(`(?:^|[^a-z0-9])${escapeRegex(synLower)}(?:$|[^a-z0-9])`, "i");
          if (boundaryRe.test(rawNorm)) {
            matched = true;
            break;
          }
        }
      } else {
        if (rawNorm && rawNorm.includes(synLower)) {
          matched = true;
          break;
        }
        if (normalizedTokens.some((tok) => tok.length >= synLower.length && tok.includes(synLower))) {
          matched = true;
          break;
        }
      }
    }
    if (matched) {
      for (const syn of cluster) {
        add(syn);
      }
    }
  }
  return out;
}

const DEFAULT_CALLER_PRINCIPALS: PrincipalId[] = ["sugent_self", "owner:M"];

const CJK_STOP_RE =
  /(请问|一下|什么情况|是什么|怎么|情况|目前|现在|关于|能不能|可以|帮我|的|了|吗|呢|啊|吧)/g;

function tokenizeBaseForSearch(text: string): string[] {
  const lower = String(text ?? "").toLowerCase().trim();
  if (!lower) return [];
  const tokens: string[] = [];
  const seen = new Set<string>();
  const pushTok = (tok: string) => {
    if (!tok || seen.has(tok)) return;
    seen.add(tok);
    tokens.push(tok);
  };

  for (const m of lower.matchAll(/(?:^|[^a-z0-9])net\s*(30|60|90)(?=$|[^a-z0-9])/g)) {
    if (m[1]) {
      pushTok(`net${m[1]}`);
      pushTok("net");
    }
  }
  if (/0\s*首付/.test(lower)) {
    pushTok("0首付");
  }

  for (const seg of lower.split(/[\s,.;:!?，。；：！？、()（）【】\[\]"'“”‘’]+/).filter(Boolean)) {
    const asciiMatches = seg.match(/[a-z0-9_.:/-]{2,}/g) ?? [];
    for (const tok of asciiMatches) {
      pushTok(tok);
      const subParts = tok.split(/[.:/_-]+/).filter((p) => p.length >= 2);
      if (subParts.length > 1) {
        for (const sp of subParts) pushTok(sp);
      }
    }
    const cjkClean = seg.replace(CJK_STOP_RE, " ");
    for (const cjkSeg of cjkClean.split(/\s+/).filter(Boolean)) {
      const chars = Array.from(cjkSeg).filter((ch) => /\p{Script=Han}/u.test(ch));
      if (chars.length === 1) {
        pushTok(chars[0]!);
      } else if (chars.length >= 2) {
        for (let i = 0; i + 1 < chars.length; i++) {
          pushTok(chars[i]! + chars[i + 1]!);
        }
        for (let i = 0; i + 2 < chars.length; i++) {
          pushTok(chars[i]! + chars[i + 1]! + chars[i + 2]!);
        }
      }
    }
  }
  return tokens;
}

export function tokenizeForSearch(text: string): string[] {
  const raw = String(text ?? "").trim();
  if (!raw) return [];
  const baseTokens = tokenizeBaseForSearch(raw);
  return expandSearchSynonyms(baseTokens, raw);
}

function buildSearchText(node: AtlasNode): string {
  const raw = `${node.id} ${node.plane} ${node.kind} ${node.name} ${node.summary} ${node.tags.join(" ")} ${(node.steps ?? []).join(" ")}`;
  return tokenizeForSearch(raw).join(" ");
}

function isOwnerOnlyProvenanceEdge(edge: {
  relation: string;
  isMembraneEdge?: boolean;
  principalAcl?: readonly PrincipalId[];
}): boolean {
  if (edge.relation !== "derived_from_episode" || edge.isMembraneEdge === true) return false;
  if (!edge.principalAcl || edge.principalAcl.length === 0) return false;
  const unique = Array.from(new Set(edge.principalAcl));
  return unique.length === 1 && unique[0] === "owner:M";
}

function defaultPrincipalsForPlane(plane: GraphPlaneId): PrincipalId[] {
  if (plane === "owner_life") return ["owner:M"];
  return ["sugent_self", "owner:M"];
}

function hasPrincipalAccess(
  acl: readonly PrincipalId[] | undefined,
  callerPrincipals: readonly PrincipalId[],
): boolean {
  if (!acl || acl.length === 0) return false;
  const callerSet = new Set<string>(callerPrincipals);
  return acl.some((p) => p === "public" || callerSet.has(p));
}

function classifyLegacyNode(
  id: string,
  kind: string,
  reinforcements: number,
  defaultPlane: GraphPlaneId,
): { plane: GraphPlaneId; stratum: EpistemicStratum; principalAcl: PrincipalId[] } {
  if (id.startsWith("self:")) {
    return {
      plane: "self_core",
      stratum: kind === "workflow" ? "crystallized_wisdom" : "digested_state",
      principalAcl: ["sugent_self", "owner:M"],
    };
  }
  if (/^(?:goal|commit|guard|res|mem|user|scope):/.test(id)) {
    return {
      plane: "owner_life",
      stratum: id.startsWith("guard:") ? "crystallized_wisdom" : "verified_fact",
      principalAcl: ["owner:M"],
    };
  }
  if (/^(?:rel|duo|crystal|peer):/.test(id)) {
    const parts = id.split(":");
    const sub = parts[1] || "default";
    const plane: GraphPlaneId = id.startsWith("peer:")
      ? `relational:peer:${sub}`
      : id.startsWith("rel:")
        ? `relational:${sub}`
        : `relational:duo:${sub}`;
    const principalAcl: PrincipalId[] = id.startsWith("peer:")
      ? ["owner:M", `peer:${sub}`]
      : ["sugent_self", "owner:M"];
    return {
      plane,
      stratum: id.startsWith("crystal:") ? "crystallized_wisdom" : "verified_fact",
      principalAcl,
    };
  }
  if (/^(?:proj|repo|cap|fde):/.test(id)) {
    const key = id.split(":")[1] || "default";
    return {
      plane: `domain_work:${key}`,
      stratum: kind === "workflow" ? "crystallized_wisdom" : "verified_fact",
      principalAcl: ["sugent_self", "owner:M"],
    };
  }
  if (/^(?:wf|sim):/.test(id)) {
    return {
      plane: "meta_evolution",
      stratum:
        id.startsWith("wf:") && reinforcements >= 3
          ? "crystallized_wisdom"
          : id.startsWith("sim:")
            ? "digested_state"
            : "verified_fact",
      principalAcl: ["sugent_self", "owner:M"],
    };
  }
  return {
    plane: defaultPlane,
    stratum: kind === "workflow" ? "crystallized_wisdom" : "verified_fact",
    principalAcl: defaultPrincipalsForPlane(defaultPlane),
  };
}

class InProcessBM25Index {
  private postings = new Map<string, Map<string, number>>();
  private docLengths = new Map<string, number>();
  private totalLength = 0;

  upsert(docId: string, tokens: string[]): void {
    this.remove(docId);
    if (tokens.length === 0) return;
    this.docLengths.set(docId, tokens.length);
    this.totalLength += tokens.length;
    const tfMap = new Map<string, number>();
    for (const tok of tokens) {
      tfMap.set(tok, (tfMap.get(tok) ?? 0) + 1);
    }
    for (const [tok, tf] of tfMap.entries()) {
      let docs = this.postings.get(tok);
      if (!docs) {
        docs = new Map<string, number>();
        this.postings.set(tok, docs);
      }
      docs.set(docId, tf);
    }
  }

  remove(docId: string): void {
    const prevLen = this.docLengths.get(docId);
    if (prevLen === undefined) return;
    this.docLengths.delete(docId);
    this.totalLength -= prevLen;
    for (const [tok, docs] of this.postings.entries()) {
      docs.delete(docId);
      if (docs.size === 0) this.postings.delete(tok);
    }
  }

  score(queryTokens: string[]): Map<string, number> {
    const scores = new Map<string, number>();
    const N = this.docLengths.size;
    if (N === 0 || queryTokens.length === 0) return scores;
    const avgdl = Math.max(1, this.totalLength / N);
    const k1 = 1.5;
    const b = 0.75;
    const uniqueTerms = Array.from(new Set(queryTokens));
    for (const term of uniqueTerms) {
      const docs = this.postings.get(term);
      if (!docs) continue;
      const df = docs.size;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (const [docId, tf] of docs.entries()) {
        const dl = this.docLengths.get(docId) ?? avgdl;
        const denom = tf + k1 * (1 - b + b * (dl / avgdl));
        const bm25 = idf * ((tf * (k1 + 1)) / denom);
        scores.set(docId, (scores.get(docId) ?? 0) + bm25);
      }
    }
    return scores;
  }
}

function defaultConfidence(stratum: EpistemicStratum): number {
  if (stratum === "crystallized_wisdom") return 0.95;
  if (stratum === "digested_state") return 0.8;
  if (stratum === "verified_fact") return 0.9;
  return 0.6;
}

export class StereoscopicAtlas {
  readonly rootDir: string;
  readonly isMemory: boolean;
  readonly fts5Enabled: boolean;
  private readonly dbPath: string;
  private readonly snapshotPath: string;
  private readonly db: DatabaseSync;
  private readonly bm25 = new InProcessBM25Index();
  private embeddingPort: AtlasEmbeddingPort | undefined;
  private embeddings = new Map<
    string,
    { dim: number; vector: Float32Array; modelId: string; updatedAt: string }
  >();
  private nodes = new Map<string, AtlasNode>();
  private edges = new Map<string, AtlasEdge>();
  private closed = false;

  constructor(rootDirOrMemory: string, opts?: { embeddingPort?: AtlasEmbeddingPort }) {
    this.isMemory = rootDirOrMemory === ":memory:";
    this.rootDir = this.isMemory ? ":memory:" : path.resolve(rootDirOrMemory);
    this.dbPath = this.isMemory ? ":memory:" : path.join(this.rootDir, "atlas.db");
    this.snapshotPath = this.isMemory ? "" : path.join(this.rootDir, "atlas-snapshot.json");
    this.embeddingPort = opts?.embeddingPort;
    if (!this.isMemory) {
      fs.mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(this.dbPath);
    if (!this.isMemory) {
      this.db.exec("PRAGMA journal_mode = WAL;");
      try {
        fs.chmodSync(this.dbPath, 0o600);
      } catch {
        /* ignore */
      }
    }
    this.fts5Enabled = this.initSchema();
    this.loadFromDb();
  }

  attachEmbeddingPort(port: AtlasEmbeddingPort | undefined): void {
    this.embeddingPort = port;
  }

  private initSchema(): boolean {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS atlas_nodes (
        id TEXT PRIMARY KEY,
        plane TEXT NOT NULL,
        stratum TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        summary TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        principal_acl_json TEXT NOT NULL,
        reinforcements INTEGER NOT NULL,
        confidence REAL NOT NULL,
        source_trust TEXT NOT NULL,
        steps_json TEXT,
        skill_gate_status TEXT,
        updated_at TEXT NOT NULL,
        superseded_at TEXT,
        superseded_by TEXT,
        archived_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_atlas_nodes_plane ON atlas_nodes(plane);
      CREATE INDEX IF NOT EXISTS idx_atlas_nodes_stratum ON atlas_nodes(stratum);
      CREATE TABLE IF NOT EXISTS atlas_edges (
        id TEXT PRIMARY KEY,
        plane TEXT NOT NULL,
        from_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        to_id TEXT NOT NULL,
        weight REAL NOT NULL,
        source TEXT NOT NULL,
        is_membrane_edge INTEGER NOT NULL DEFAULT 0,
        membrane_policy TEXT,
        principal_acl_json TEXT,
        valid_from TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        superseded_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_atlas_edges_from ON atlas_edges(from_id);
      CREATE INDEX IF NOT EXISTS idx_atlas_edges_to ON atlas_edges(to_id);
      CREATE TABLE IF NOT EXISTS atlas_embeddings (
        node_id TEXT PRIMARY KEY,
        dim INTEGER NOT NULL,
        vector_blob BLOB NOT NULL,
        model_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    try {
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS atlas_fts USING fts5(node_id UNINDEXED, search_text, tokenize='unicode61');`,
      );
      return true;
    } catch {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS atlas_search_index (
          node_id TEXT PRIMARY KEY,
          search_text TEXT NOT NULL,
          tokens_json TEXT NOT NULL,
          doc_len INTEGER NOT NULL
        );
      `);
      return false;
    }
  }

  private loadFromDb(): void {
    const nodeRows = this.db.prepare("SELECT * FROM atlas_nodes").all() as Record<string, unknown>[];
    const edgeRows = this.db.prepare("SELECT * FROM atlas_edges").all() as Record<string, unknown>[];
    for (const row of nodeRows) {
      const node = this.rowToNode(row);
      this.nodes.set(node.id, node);
      if (!node.supersededAt && !node.archivedAt) {
        if (!this.fts5Enabled) {
          const searchText = buildSearchText(node);
          this.bm25.upsert(node.id, searchText ? searchText.split(/\s+/).filter(Boolean) : []);
        }
      }
    }
    for (const row of edgeRows) {
      const edge = this.rowToEdge(row);
      this.edges.set(edge.id, edge);
    }
    const embRows = this.db
      .prepare("SELECT node_id, dim, vector_blob, model_id, updated_at FROM atlas_embeddings")
      .all() as Record<string, unknown>[];
    for (const row of embRows) {
      const nodeId = String(row.node_id);
      const node = this.nodes.get(nodeId);
      if (!node || node.supersededAt || node.archivedAt) {
        this.db.prepare("DELETE FROM atlas_embeddings WHERE node_id = ?").run(nodeId);
        continue;
      }
      const rawBlob = row.vector_blob;
      if (rawBlob instanceof Uint8Array) {
        const vec = decodeFloat32Blob(rawBlob);
        if (vec.length > 0) {
          this.embeddings.set(nodeId, {
            dim: Number(row.dim) || vec.length,
            vector: vec,
            modelId: String(row.model_id),
            updatedAt: String(row.updated_at),
          });
        }
      }
    }
    if (this.nodes.size === 0 && !this.isMemory && fs.existsSync(this.snapshotPath)) {
      this.hydrateFromSnapshot();
    }
  }

  private hydrateFromSnapshot(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.snapshotPath, "utf8")) as {
        nodes?: AtlasNode[];
        edges?: AtlasEdge[];
      };
      this.db.exec("BEGIN");
      try {
        for (const n of raw.nodes ?? []) {
          this.nodes.set(n.id, n);
          this.persistNode(n);
          this.syncSearchIndex(n);
        }
        for (const e of raw.edges ?? []) {
          this.edges.set(e.id, e);
          this.persistEdge(e);
        }
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    } catch {
      /* ignore corrupted snapshot */
    }
  }

  private rowToNode(row: Record<string, unknown>): AtlasNode {
    const steps = row.steps_json ? (JSON.parse(String(row.steps_json)) as string[]) : undefined;
    return {
      id: String(row.id),
      plane: String(row.plane) as GraphPlaneId,
      stratum: String(row.stratum) as EpistemicStratum,
      kind: String(row.kind) as AtlasNodeKind,
      name: String(row.name),
      summary: String(row.summary),
      tags: JSON.parse(String(row.tags_json)) as string[],
      principalAcl: JSON.parse(String(row.principal_acl_json)) as PrincipalId[],
      reinforcements: Number(row.reinforcements),
      confidence: Number(row.confidence),
      sourceTrust: String(row.source_trust) as SourceTrust,
      ...(steps?.length ? { steps } : {}),
      ...(row.skill_gate_status ? { skillGateStatus: String(row.skill_gate_status) as SkillGateStatus } : {}),
      updatedAt: String(row.updated_at),
      ...(row.superseded_at ? { supersededAt: String(row.superseded_at) } : {}),
      ...(row.superseded_by ? { supersededBy: String(row.superseded_by) } : {}),
      ...(row.archived_at ? { archivedAt: String(row.archived_at) } : {}),
    };
  }

  private rowToEdge(row: Record<string, unknown>): AtlasEdge {
    const acl = row.principal_acl_json
      ? (JSON.parse(String(row.principal_acl_json)) as PrincipalId[])
      : undefined;
    return {
      id: String(row.id),
      plane: String(row.plane) as GraphPlaneId,
      from: String(row.from_id),
      relation: String(row.relation),
      to: String(row.to_id),
      weight: Number(row.weight),
      source: String(row.source),
      ...(Number(row.is_membrane_edge) === 1 ? { isMembraneEdge: true } : {}),
      ...(row.membrane_policy ? { membranePolicy: String(row.membrane_policy) } : {}),
      ...(acl?.length ? { principalAcl: acl } : {}),
      validFrom: String(row.valid_from),
      updatedAt: String(row.updated_at),
      ...(row.superseded_at ? { supersededAt: String(row.superseded_at) } : {}),
    };
  }

  private persistNode(node: AtlasNode): void {
    this.db
      .prepare(
        `INSERT INTO atlas_nodes (
          id, plane, stratum, kind, name, summary, tags_json, principal_acl_json,
          reinforcements, confidence, source_trust, steps_json, skill_gate_status,
          updated_at, superseded_at, superseded_by, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          plane=excluded.plane, stratum=excluded.stratum, kind=excluded.kind,
          name=excluded.name, summary=excluded.summary, tags_json=excluded.tags_json,
          principal_acl_json=excluded.principal_acl_json, reinforcements=excluded.reinforcements,
          confidence=excluded.confidence, source_trust=excluded.source_trust,
          steps_json=excluded.steps_json, skill_gate_status=excluded.skill_gate_status,
          updated_at=excluded.updated_at, superseded_at=excluded.superseded_at,
          superseded_by=excluded.superseded_by, archived_at=excluded.archived_at`,
      )
      .run(
        node.id,
        node.plane,
        node.stratum,
        node.kind,
        node.name,
        node.summary,
        JSON.stringify(node.tags),
        JSON.stringify(node.principalAcl),
        node.reinforcements,
        node.confidence,
        node.sourceTrust,
        node.steps?.length ? JSON.stringify(node.steps) : null,
        node.skillGateStatus ?? null,
        node.updatedAt,
        node.supersededAt ?? null,
        node.supersededBy ?? null,
        node.archivedAt ?? null,
      );
  }

  private persistEdge(edge: AtlasEdge): void {
    this.db
      .prepare(
        `INSERT INTO atlas_edges (
          id, plane, from_id, relation, to_id, weight, source,
          is_membrane_edge, membrane_policy, principal_acl_json,
          valid_from, updated_at, superseded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          plane=excluded.plane, from_id=excluded.from_id, relation=excluded.relation,
          to_id=excluded.to_id, weight=excluded.weight, source=excluded.source,
          is_membrane_edge=excluded.is_membrane_edge, membrane_policy=excluded.membrane_policy,
          principal_acl_json=excluded.principal_acl_json, valid_from=excluded.valid_from,
          updated_at=excluded.updated_at, superseded_at=excluded.superseded_at`,
      )
      .run(
        edge.id,
        edge.plane,
        edge.from,
        edge.relation,
        edge.to,
        edge.weight,
        edge.source,
        edge.isMembraneEdge ? 1 : 0,
        edge.membranePolicy ?? null,
        edge.principalAcl?.length ? JSON.stringify(edge.principalAcl) : null,
        edge.validFrom,
        edge.updatedAt,
        edge.supersededAt ?? null,
      );
  }

  private removeNodeEmbedding(nodeId: string): void {
    this.db.prepare("DELETE FROM atlas_embeddings WHERE node_id = ?").run(nodeId);
    this.embeddings.delete(nodeId);
  }

  private buildEmbeddingText(node: AtlasNode): string {
    return `${node.name}\n${node.summary}\n${node.tags.join(" ")}`.trim();
  }

  upsertNodeEmbedding(
    nodeId: string,
    vector: ArrayLike<number>,
    modelId = "byok-embedding",
    nowIso = new Date().toISOString(),
  ): void {
    if (!nodeId || vector.length === 0) return;
    const blob = encodeFloat32Blob(vector);
    const decoded = decodeFloat32Blob(blob);
    const dim = decoded.length;
    if (dim === 0) return;
    this.db
      .prepare(
        `INSERT INTO atlas_embeddings (node_id, dim, vector_blob, model_id, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           dim=excluded.dim, vector_blob=excluded.vector_blob,
           model_id=excluded.model_id, updated_at=excluded.updated_at`,
      )
      .run(nodeId, dim, blob, modelId, nowIso);
    this.embeddings.set(nodeId, {
      dim,
      vector: decoded,
      modelId,
      updatedAt: nowIso,
    });
  }

  getNodeEmbedding(
    nodeId: string,
  ): { dim: number; vector: Float32Array; modelId: string; updatedAt: string } | undefined {
    const entry = this.embeddings.get(nodeId);
    if (!entry) return undefined;
    return {
      dim: entry.dim,
      vector: entry.vector.slice(),
      modelId: entry.modelId,
      updatedAt: entry.updatedAt,
    };
  }

  async indexMissingEmbeddings(opts?: { limit?: number; modelId?: string }): Promise<{ indexed: number }> {
    const port = this.embeddingPort;
    if (!port || (!port.embedBatch && !port.embedSync)) {
      return { indexed: 0 };
    }
    const limit = Math.max(0, opts?.limit ?? 100);
    if (limit === 0) return { indexed: 0 };
    const targetModelId = opts?.modelId ?? port.modelId ?? "byok-embedding";
    const missing: AtlasNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.supersededAt || node.archivedAt) continue;
      const existingEmb = this.embeddings.get(node.id);
      if (existingEmb && (!opts?.modelId || existingEmb.modelId === opts.modelId)) {
        continue;
      }
      missing.push(node);
      if (missing.length >= limit) break;
    }
    if (missing.length === 0) return { indexed: 0 };

    const nowIso = new Date().toISOString();
    let indexed = 0;
    if (port.embedBatch) {
      try {
        const texts = missing.map((n) => this.buildEmbeddingText(n));
        const vectors = await port.embedBatch(texts);
        this.db.exec("BEGIN");
        try {
          for (let i = 0; i < missing.length; i++) {
            const vec = vectors[i];
            if (vec && vec.length > 0) {
              this.upsertNodeEmbedding(missing[i]!.id, vec, targetModelId, nowIso);
              indexed += 1;
            }
          }
          this.db.exec("COMMIT");
        } catch (err) {
          this.db.exec("ROLLBACK");
          throw err;
        }
        return { indexed };
      } catch {
        if (!port.embedSync) return { indexed: 0 };
      }
    }

    if (port.embedSync) {
      this.db.exec("BEGIN");
      try {
        for (const node of missing) {
          try {
            const vec = port.embedSync(this.buildEmbeddingText(node));
            if (vec && vec.length > 0) {
              this.upsertNodeEmbedding(node.id, vec, targetModelId, nowIso);
              indexed += 1;
            }
          } catch {
            /* graceful skip on offline / transient embedding error */
          }
        }
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    }
    return { indexed };
  }

  private removeFromSearchIndex(nodeId: string): void {
    if (this.fts5Enabled) {
      this.db.prepare("DELETE FROM atlas_fts WHERE node_id = ?").run(nodeId);
    } else {
      this.db.prepare("DELETE FROM atlas_search_index WHERE node_id = ?").run(nodeId);
      this.bm25.remove(nodeId);
    }
    this.removeNodeEmbedding(nodeId);
  }

  private syncSearchIndex(node: AtlasNode): void {
    if (node.supersededAt || node.archivedAt) {
      this.removeFromSearchIndex(node.id);
      return;
    }
    const searchText = buildSearchText(node);
    const tokens = searchText ? searchText.split(/\s+/).filter(Boolean) : [];
    if (this.fts5Enabled) {
      this.db.prepare("DELETE FROM atlas_fts WHERE node_id = ?").run(node.id);
      this.db.prepare("INSERT INTO atlas_fts (node_id, search_text) VALUES (?, ?)").run(node.id, searchText);
    } else {
      this.db
        .prepare(
          `INSERT INTO atlas_search_index (node_id, search_text, tokens_json, doc_len)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(node_id) DO UPDATE SET
             search_text=excluded.search_text, tokens_json=excluded.tokens_json, doc_len=excluded.doc_len`,
        )
        .run(node.id, searchText, JSON.stringify(tokens), tokens.length);
      this.bm25.upsert(node.id, tokens);
    }
    if (this.embeddingPort?.embedSync) {
      try {
        const vec = this.embeddingPort.embedSync(this.buildEmbeddingText(node));
        if (vec && vec.length > 0) {
          this.upsertNodeEmbedding(
            node.id,
            vec,
            this.embeddingPort.modelId ?? "byok-embedding",
            node.updatedAt,
          );
        }
      } catch {
        /* graceful offline fallback */
      }
    }
  }

  private writeSnapshot(): void {
    if (this.isMemory) return;
    fs.mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    const payload = this.snapshot();
    const tmp = `${this.snapshotPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this.snapshotPath);
    try {
      fs.chmodSync(this.dbPath, 0o600);
      fs.chmodSync(this.snapshotPath, 0o600);
    } catch {
      /* ignore */
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  getNode(id: string): AtlasNode | undefined {
    return this.nodes.get(id);
  }

  getEdge(id: string): AtlasEdge | undefined {
    return this.edges.get(id);
  }

  allNodes(opts?: { includeSuperseded?: boolean; plane?: GraphPlaneId }): AtlasNode[] {
    const includeSuperseded = Boolean(opts?.includeSuperseded);
    return Array.from(this.nodes.values()).filter((n) => {
      if (!includeSuperseded && (n.supersededAt || n.archivedAt)) return false;
      if (opts?.plane && n.plane !== opts.plane) return false;
      return true;
    });
  }

  activeEdges(plane?: GraphPlaneId): AtlasEdge[] {
    return Array.from(this.edges.values()).filter(
      (e) => !e.supersededAt && (!plane || e.plane === plane),
    );
  }

  allEdges(): AtlasEdge[] {
    return Array.from(this.edges.values());
  }

  snapshot(): { version: 2; updatedAt: string; nodes: AtlasNode[]; edges: AtlasEdge[] } {
    return {
      version: 2,
      updatedAt: new Date().toISOString(),
      nodes: Array.from(this.nodes.values()),
      edges: Array.from(this.edges.values()),
    };
  }

  private buildMergedNode(input: AtlasNodeInput, now: string): AtlasNode {
    const existing = this.nodes.get(input.id);
    const stratum: EpistemicStratum = input.stratum ?? existing?.stratum ?? "verified_fact";
    const principalAcl: PrincipalId[] =
      input.principalAcl && input.principalAcl.length > 0
        ? Array.from(new Set(input.principalAcl))
        : existing?.principalAcl && existing.principalAcl.length > 0
          ? existing.principalAcl
          : defaultPrincipalsForPlane(input.plane);
    const gateStatus = input.skillGateStatus ?? existing?.skillGateStatus;
    const steps = input.steps ?? existing?.steps;
    return {
      id: input.id.trim(),
      plane: input.plane,
      stratum,
      kind: input.kind,
      name: input.name.trim(),
      summary: input.summary.trim(),
      tags: Array.from(new Set([...(existing?.tags ?? []), ...(input.tags ?? [])])),
      principalAcl,
      reinforcements: (existing?.reinforcements ?? 0) + (input.reinforcements ?? 1),
      confidence: input.confidence ?? existing?.confidence ?? defaultConfidence(stratum),
      sourceTrust: input.sourceTrust ?? existing?.sourceTrust ?? "owner_confirmed",
      ...(steps?.length ? { steps } : {}),
      ...(gateStatus ? { skillGateStatus: gateStatus } : {}),
      updatedAt: now,
      ...(input.archivedAt ? { archivedAt: input.archivedAt } : {}),
    };
  }

  private validateDelta(delta: AtlasDelta, now: string): Map<string, AtlasNode> {
    const projectedNodes = new Map<string, AtlasNode>(this.nodes);
    for (const input of delta.nodes ?? []) {
      const secretText = `${input.name}\n${input.summary}\n${(input.tags ?? []).join(" ")}\n${(input.steps ?? []).join(" ")}`;
      if (looksSecret(secretText)) {
        throw new AtlasError("ATLAS_SECRET_REJECTED", `Refused secret-like content in node ${input.id}`);
      }
      projectedNodes.set(input.id.trim(), this.buildMergedNode(input, now));
    }
    for (const edge of delta.edges ?? []) {
      if (looksSecret(`${edge.relation} ${edge.source} ${edge.membranePolicy ?? ""}`)) {
        throw new AtlasError("ATLAS_SECRET_REJECTED", `Refused secret-like content in edge ${edge.from}->${edge.to}`);
      }
      const fromNode = projectedNodes.get(edge.from);
      const toNode = projectedNodes.get(edge.to);
      const isCrossPlane =
        Boolean(edge.isMembraneEdge) || Boolean(fromNode && toNode && fromNode.plane !== toNode.plane);
      if (
        isCrossPlane &&
        !isOwnerOnlyProvenanceEdge(edge) &&
        (fromNode?.stratum === "raw_episodic" || toNode?.stratum === "raw_episodic")
      ) {
        throw new AtlasError(
          "ATLAS_RAW_MEMBRANE_FORBIDDEN",
          `Cannot create cross-plane or membrane edge involving raw_episodic node (${edge.from} -> ${edge.to})`,
        );
      }
    }
    for (const input of delta.nodes ?? []) {
      const merged = projectedNodes.get(input.id.trim())!;
      if (merged.stratum !== "raw_episodic") continue;
      for (const edge of this.edges.values()) {
        if (edge.supersededAt || (edge.from !== merged.id && edge.to !== merged.id)) continue;
        const fromN = projectedNodes.get(edge.from);
        const toN = projectedNodes.get(edge.to);
        if (
          (edge.isMembraneEdge || (fromN && toN && fromN.plane !== toN.plane)) &&
          !isOwnerOnlyProvenanceEdge(edge)
        ) {
          throw new AtlasError("ATLAS_RAW_MEMBRANE_FORBIDDEN", `Node ${merged.id} has active membrane edge`);
        }
      }
    }
    return projectedNodes;
  }

  private markNodeSuperseded(nodeId: string, supersededBy: string | undefined, now: string): boolean {
    const node = this.nodes.get(nodeId);
    if (!node || node.supersededAt) return false;
    node.supersededAt = now;
    if (supersededBy) node.supersededBy = supersededBy;
    node.updatedAt = now;
    this.persistNode(node);
    this.removeFromSearchIndex(node.id);
    return true;
  }

  private hasActiveEdges(nodeId: string): boolean {
    for (const e of this.edges.values()) {
      if (!e.supersededAt && (e.from === nodeId || e.to === nodeId)) return true;
    }
    return false;
  }

  applyDelta(
    delta: AtlasDelta,
    now = new Date().toISOString(),
  ): { upsertedNodes: number; upsertedEdges: number; supersededNodes: number; supersededEdges: number } {
    const projectedNodes = this.validateDelta(delta, now);
    let upsertedNodes = 0;
    let upsertedEdges = 0;
    let supersededNodes = 0;
    let supersededEdges = 0;
    const orphanCandidates = new Map<string, string>();
    const explicitSupersedes = new Map<string, string>();

    this.db.exec("BEGIN");
    try {
      for (const input of delta.nodes ?? []) {
        const merged = projectedNodes.get(input.id.trim())!;
        this.nodes.set(merged.id, merged);
        this.persistNode(merged);
        this.syncSearchIndex(merged);
        upsertedNodes++;
      }
      for (const edgeInput of delta.edges ?? []) {
        if (edgeInput.exclusive) {
          for (const existingEdge of this.edges.values()) {
            if (
              !existingEdge.supersededAt &&
              existingEdge.from === edgeInput.from &&
              existingEdge.relation === edgeInput.relation &&
              existingEdge.to !== edgeInput.to
            ) {
              existingEdge.supersededAt = now;
              existingEdge.updatedAt = now;
              this.persistEdge(existingEdge);
              supersededEdges++;
              orphanCandidates.set(existingEdge.to, edgeInput.to);
            }
          }
        }
        if (edgeInput.supersedeNodeId) {
          explicitSupersedes.set(edgeInput.supersedeNodeId, edgeInput.to);
        }
        const fromNode = this.nodes.get(edgeInput.from);
        const toNode = this.nodes.get(edgeInput.to);
        const crossPlane = Boolean(fromNode && toNode && fromNode.plane !== toNode.plane);
        const isMembrane = Boolean(edgeInput.isMembraneEdge) || (crossPlane && !isOwnerOnlyProvenanceEdge(edgeInput));
        const plane: GraphPlaneId = edgeInput.plane ?? fromNode?.plane ?? toNode?.plane ?? "owner_life";
        const edgeId = `${edgeInput.from}--${edgeInput.relation}-->${edgeInput.to}`;
        const existing = this.edges.get(edgeId);
        const edge: AtlasEdge = {
          id: edgeId,
          plane,
          from: edgeInput.from,
          relation: edgeInput.relation,
          to: edgeInput.to,
          weight: edgeInput.weight ?? (existing ? existing.weight + 1 : 1),
          source: edgeInput.source,
          ...(isMembrane ? { isMembraneEdge: true } : {}),
          ...(edgeInput.membranePolicy ? { membranePolicy: edgeInput.membranePolicy } : {}),
          ...(edgeInput.principalAcl?.length ? { principalAcl: Array.from(new Set(edgeInput.principalAcl)) } : {}),
          validFrom: existing?.validFrom ?? now,
          updatedAt: now,
        };
        this.edges.set(edgeId, edge);
        this.persistEdge(edge);
        upsertedEdges++;
      }
      for (const [nodeId, newTo] of explicitSupersedes.entries()) {
        if (this.markNodeSuperseded(nodeId, newTo, now)) supersededNodes++;
      }
      for (const [oldTo, newTo] of orphanCandidates.entries()) {
        if (!explicitSupersedes.has(oldTo) && !this.hasActiveEdges(oldTo)) {
          if (this.markNodeSuperseded(oldTo, newTo, now)) supersededNodes++;
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.writeSnapshot();
    return { upsertedNodes, upsertedEdges, supersededNodes, supersededEdges };
  }

  removeEdge(edgeId: string, now = new Date().toISOString()): boolean {
    const existing = this.edges.get(edgeId);
    if (!existing || existing.supersededAt) return false;
    this.db.exec("BEGIN");
    try {
      existing.supersededAt = now;
      existing.updatedAt = now;
      this.persistEdge(existing);
      if (!this.hasActiveEdges(existing.to)) {
        this.markNodeSuperseded(existing.to, undefined, now);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.writeSnapshot();
    return true;
  }

  supersedeNode(nodeId: string, supersededBy?: string, now = new Date().toISOString()): boolean {
    const existing = this.nodes.get(nodeId);
    if (!existing || existing.supersededAt) return false;
    this.db.exec("BEGIN");
    try {
      this.markNodeSuperseded(nodeId, supersededBy, now);
      for (const e of this.edges.values()) {
        if (!e.supersededAt && (e.from === nodeId || e.to === nodeId)) {
          e.supersededAt = now;
          e.updatedAt = now;
          this.persistEdge(e);
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.writeSnapshot();
    return true;
  }

  archiveNode(nodeId: string, now = new Date().toISOString()): boolean {
    const node = this.nodes.get(nodeId);
    if (!node || node.archivedAt) return false;
    this.db.exec("BEGIN");
    try {
      node.archivedAt = now;
      node.updatedAt = now;
      this.persistNode(node);
      this.removeFromSearchIndex(node.id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.writeSnapshot();
    return true;
  }

  promoteNodeStratum(
    nodeId: string,
    stratum: EpistemicStratum,
    opts?: { sourceTrust?: SourceTrust; confidence?: number; nowIso?: string },
  ): AtlasNode | undefined {
    const existing = this.nodes.get(nodeId);
    if (!existing || existing.supersededAt || existing.archivedAt) return undefined;
    const now = opts?.nowIso ?? new Date().toISOString();
    const updated: AtlasNode = {
      ...existing,
      stratum,
      confidence: Math.max(existing.confidence, opts?.confidence ?? defaultConfidence(stratum)),
      ...(opts?.sourceTrust ? { sourceTrust: opts.sourceTrust } : {}),
      updatedAt: now,
    };
    this.db.exec("BEGIN");
    try {
      this.nodes.set(updated.id, updated);
      this.persistNode(updated);
      this.syncSearchIndex(updated);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.writeSnapshot();
    return updated;
  }

  importLosslessSnapshot(snapshot: {
    nodes: readonly AtlasNode[];
    edges: readonly AtlasEdge[];
  }): { importedNodes: number; importedEdges: number } {
    const projectedNodes = new Map<string, AtlasNode>(this.nodes);
    const preparedNodes: AtlasNode[] = [];
    for (const n of snapshot.nodes ?? []) {
      const secretText = `${n.name}\n${n.summary}\n${(n.tags ?? []).join(" ")}\n${(n.steps ?? []).join(" ")}`;
      if (looksSecret(secretText)) {
        throw new AtlasError("ATLAS_SECRET_REJECTED", `Refused secret-like content in snapshot node ${n.id}`);
      }
      const existing = this.nodes.get(n.id);
      const keepLocalTombstone =
        Boolean(existing && (existing.supersededAt || existing.archivedAt)) &&
        Boolean(existing && existing.updatedAt > n.updatedAt);
      const cloned: AtlasNode = {
        id: n.id,
        plane: n.plane,
        stratum: n.stratum,
        kind: n.kind,
        name: n.name,
        summary: n.summary,
        tags: Array.from(new Set(n.tags ?? [])),
        principalAcl:
          n.principalAcl && n.principalAcl.length > 0
            ? Array.from(new Set(n.principalAcl))
            : defaultPrincipalsForPlane(n.plane),
        reinforcements: n.reinforcements,
        confidence: n.confidence,
        sourceTrust: n.sourceTrust,
        ...(n.steps?.length ? { steps: [...n.steps] } : {}),
        ...(n.skillGateStatus ? { skillGateStatus: n.skillGateStatus } : {}),
        updatedAt: keepLocalTombstone && existing ? existing.updatedAt : n.updatedAt,
        ...(n.supersededAt
          ? { supersededAt: n.supersededAt }
          : keepLocalTombstone && existing?.supersededAt
            ? { supersededAt: existing.supersededAt }
            : {}),
        ...(n.supersededBy
          ? { supersededBy: n.supersededBy }
          : keepLocalTombstone && existing?.supersededBy
            ? { supersededBy: existing.supersededBy }
            : {}),
        ...(n.archivedAt
          ? { archivedAt: n.archivedAt }
          : keepLocalTombstone && existing?.archivedAt
            ? { archivedAt: existing.archivedAt }
            : {}),
      };
      preparedNodes.push(cloned);
      projectedNodes.set(cloned.id, cloned);
    }

    const preparedEdges: AtlasEdge[] = [];
    for (const e of snapshot.edges ?? []) {
      if (looksSecret(`${e.relation} ${e.source} ${e.membranePolicy ?? ""}`)) {
        throw new AtlasError("ATLAS_SECRET_REJECTED", `Refused secret-like content in snapshot edge ${e.from}->${e.to}`);
      }
      const fromNode = projectedNodes.get(e.from);
      const toNode = projectedNodes.get(e.to);
      const isCrossPlane =
        Boolean(e.isMembraneEdge) || Boolean(fromNode && toNode && fromNode.plane !== toNode.plane);
      if (
        !e.supersededAt &&
        isCrossPlane &&
        !isOwnerOnlyProvenanceEdge(e) &&
        (fromNode?.stratum === "raw_episodic" || toNode?.stratum === "raw_episodic")
      ) {
        throw new AtlasError(
          "ATLAS_RAW_MEMBRANE_FORBIDDEN",
          `Cannot import cross-plane or membrane edge involving raw_episodic node (${e.from} -> ${e.to})`,
        );
      }
      const edgeId = e.id || `${e.from}--${e.relation}-->${e.to}`;
      const existingEdge = this.edges.get(edgeId);
      const keepEdgeTombstone =
        Boolean(existingEdge?.supersededAt) && Boolean(existingEdge && existingEdge.updatedAt > e.updatedAt);
      const clonedEdge: AtlasEdge = {
        id: edgeId,
        plane: e.plane ?? fromNode?.plane ?? toNode?.plane ?? "owner_life",
        from: e.from,
        relation: e.relation,
        to: e.to,
        weight: e.weight,
        source: e.source,
        ...(e.isMembraneEdge ? { isMembraneEdge: true } : {}),
        ...(e.membranePolicy ? { membranePolicy: e.membranePolicy } : {}),
        ...(e.principalAcl?.length ? { principalAcl: Array.from(new Set(e.principalAcl)) } : {}),
        validFrom: e.validFrom,
        updatedAt: keepEdgeTombstone && existingEdge ? existingEdge.updatedAt : e.updatedAt,
        ...(e.supersededAt
          ? { supersededAt: e.supersededAt }
          : keepEdgeTombstone && existingEdge?.supersededAt
            ? { supersededAt: existingEdge.supersededAt }
            : {}),
      };
      preparedEdges.push(clonedEdge);
    }

    let importedNodes = 0;
    let importedEdges = 0;
    this.db.exec("BEGIN");
    try {
      for (const node of preparedNodes) {
        this.nodes.set(node.id, node);
        this.persistNode(node);
        this.syncSearchIndex(node);
        importedNodes += 1;
      }
      for (const edge of preparedEdges) {
        this.edges.set(edge.id, edge);
        this.persistEdge(edge);
        importedEdges += 1;
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.writeSnapshot();
    return { importedNodes, importedEdges };
  }

  traceEpisodeProvenance(
    nodeId: string,
    opts?: {
      callerPrincipals?: readonly PrincipalId[];
      maxDepth?: number;
      lookupTranscript?: (
        hint: EpisodeProvenanceLookupHint,
      ) => Array<{ atIso: string; channel: string; role: string; snippet: string; episodeId?: string }>;
    },
  ): EpisodeProvenanceResult {
    const callerPrincipals = opts?.callerPrincipals ?? DEFAULT_CALLER_PRINCIPALS;
    if (!callerPrincipals.includes("owner:M")) {
      return {
        allowed: false,
        errorCode: "PROVENANCE_OWNER_ONLY",
        chain: [],
        episodeNodes: [],
        transcriptSnippets: [],
      };
    }

    const startNode = this.nodes.get(nodeId);
    if (!startNode || !hasPrincipalAccess(startNode.principalAcl, callerPrincipals)) {
      return {
        allowed: true,
        chain: [],
        episodeNodes: [],
        transcriptSnippets: [],
      };
    }

    const maxDepth = Math.max(0, opts?.maxDepth ?? 4);
    const provenanceRelations = new Set(["derived_from_episode", "synthesized_from", "supersedes"]);
    const visitedIds = new Set<string>([startNode.id]);
    const chain: AtlasNode[] = [startNode];
    let queue: string[] = [startNode.id];

    for (let depth = 0; depth < maxDepth && queue.length > 0; depth++) {
      const nextQueue: string[] = [];
      for (const curId of queue) {
        for (const edge of this.edges.values()) {
          if (!provenanceRelations.has(edge.relation)) continue;
          if (edge.principalAcl?.length && !hasPrincipalAccess(edge.principalAcl, callerPrincipals)) continue;

          let targetId: string | undefined;
          if (edge.from === curId) {
            targetId = edge.to;
          } else if (edge.to === curId && edge.relation === "derived_from_episode") {
            const candidateFrom = this.nodes.get(edge.from);
            if (candidateFrom?.stratum === "raw_episodic") {
              targetId = edge.from;
            }
          }
          if (!targetId || visitedIds.has(targetId)) continue;
          const targetNode = this.nodes.get(targetId);
          if (!targetNode || !hasPrincipalAccess(targetNode.principalAcl, callerPrincipals)) continue;
          visitedIds.add(targetNode.id);
          chain.push(targetNode);
          nextQueue.push(targetNode.id);
        }

        for (const candidatePredecessor of this.nodes.values()) {
          if (candidatePredecessor.supersededBy !== curId) continue;
          if (visitedIds.has(candidatePredecessor.id)) continue;
          if (!hasPrincipalAccess(candidatePredecessor.principalAcl, callerPrincipals)) continue;
          visitedIds.add(candidatePredecessor.id);
          chain.push(candidatePredecessor);
          nextQueue.push(candidatePredecessor.id);
        }
      }
      queue = nextQueue;
    }

    const episodeNodes = chain.filter(
      (n) =>
        n.stratum === "raw_episodic" ||
        n.kind === "episode_anchor" ||
        n.id.startsWith("ep:") ||
        n.tags.some((t) => t === "episode_anchor" || t.startsWith("ep:") || t.startsWith("episode:")),
    );

    const transcriptSnippets: EpisodeTranscriptSnippet[] = [];
    if (opts?.lookupTranscript && episodeNodes.length > 0) {
      const seenSnippets = new Set<string>();
      for (const epNode of episodeNodes) {
        const hint = this.extractEpisodeLookupHint(epNode);
        const found = opts.lookupTranscript(hint) ?? [];
        for (const item of found) {
          const dedupKey = `${item.atIso}|${item.channel}|${item.role}|${item.snippet}`;
          if (seenSnippets.has(dedupKey)) continue;
          seenSnippets.add(dedupKey);
          transcriptSnippets.push({
            atIso: item.atIso,
            channel: item.channel,
            role: item.role,
            snippet: item.snippet,
            ...(item.episodeId ? { episodeId: item.episodeId } : hint.episodeId ? { episodeId: hint.episodeId } : {}),
          });
        }
      }
    }

    return {
      allowed: true,
      chain,
      episodeNodes,
      transcriptSnippets,
    };
  }

  private extractEpisodeLookupHint(epNode: AtlasNode): EpisodeProvenanceLookupHint {
    let episodeId: string | undefined;
    if (epNode.id.startsWith("ep:")) {
      episodeId = epNode.id;
    } else {
      for (const tag of epNode.tags) {
        if (tag.startsWith("ep:")) {
          episodeId = tag;
          break;
        }
        if (tag.startsWith("episode:")) {
          episodeId = tag.slice("episode:".length);
          break;
        }
      }
    }

    let channel: string | undefined;
    let atIso: string | undefined;
    for (const tag of epNode.tags) {
      if (!channel && tag.startsWith("channel:")) {
        channel = tag.slice("channel:".length).trim();
      } else if (!atIso && tag.startsWith("at:")) {
        const candidateIso = tag.slice("at:".length).trim();
        if (Number.isFinite(Date.parse(candidateIso))) {
          atIso = candidateIso;
        }
      }
    }

    if (episodeId) {
      const epParts = episodeId.match(/^ep:([^:]+):(\d{10,15}):/);
      if (epParts) {
        if (!channel && epParts[1]) channel = epParts[1];
        if (!atIso && epParts[2]) {
          const ts = Number(epParts[2]);
          if (Number.isFinite(ts)) atIso = new Date(ts).toISOString();
        }
      }
    }

    if (!channel) {
      const summaryCh = epNode.summary.match(/\[(weixin|feishu|web_ui|web)\]/i);
      if (summaryCh?.[1]) channel = summaryCh[1].toLowerCase();
    }
    if (!atIso && Number.isFinite(Date.parse(epNode.updatedAt))) {
      atIso = epNode.updatedAt;
    }

    return {
      episodeNodeId: epNode.id,
      ...(episodeId ? { episodeId } : {}),
      ...(channel ? { channel } : {}),
      ...(atIso ? { atIso } : {}),
      summary: epNode.summary,
    };
  }

  ingestLegacyDelta(
    delta: KGDelta,
    defaultPlane: GraphPlaneId = "owner_life",
    nowIso = new Date().toISOString(),
  ): { upsertedNodes: number; upsertedEdges: number; supersededNodes: number; supersededEdges: number } {
    const atlasNodes: AtlasNodeInput[] = (delta.nodes ?? []).map((n) => {
      const cls = classifyLegacyNode(n.id, n.kind, n.reinforcements ?? 1, defaultPlane);
      return {
        id: n.id,
        plane: cls.plane,
        stratum: cls.stratum,
        kind: n.kind,
        name: n.name,
        summary: n.summary,
        tags: n.tags,
        principalAcl: cls.principalAcl,
        reinforcements: n.reinforcements,
        sourceTrust: "legacy_import",
        ...(n.steps?.length ? { steps: n.steps } : {}),
        ...(n.skillGateStatus ? { skillGateStatus: n.skillGateStatus } : {}),
      };
    });
    const atlasEdges: AtlasEdgeInput[] = (delta.edges ?? []).map((e) => ({
      from: e.from,
      relation: e.relation,
      to: e.to,
      weight: e.weight,
      source: e.source,
      exclusive: e.exclusive,
    }));
    return this.applyDelta({ nodes: atlasNodes, edges: atlasEdges }, nowIso);
  }

  importFromLegacyKnowledgeGraph(
    kg: SugentKnowledgeGraph,
    nowIso = new Date().toISOString(),
  ): { importedNodes: number; importedEdges: number } {
    const legacyNodes = kg.allNodes();
    const legacyEdges = kg.allEdges();
    let importedNodes = 0;
    let importedEdges = 0;
    const supersededTargets = new Set<string>();
    this.db.exec("BEGIN");
    try {
      for (const n of legacyNodes) {
        const secretText = `${n.name}\n${n.summary}\n${n.tags.join(" ")}\n${(n.steps ?? []).join(" ")}`;
        if (looksSecret(secretText)) {
          throw new AtlasError("ATLAS_SECRET_REJECTED", `Refused secret-like content in legacy node ${n.id}`);
        }
        const existing = this.nodes.get(n.id);
        if (existing?.supersededAt || existing?.archivedAt) {
          continue;
        }
        const cls = classifyLegacyNode(n.id, n.kind, n.reinforcements, "owner_life");
        const nextReinforcements = existing
          ? Math.max(existing.reinforcements, n.reinforcements)
          : n.reinforcements;
        const merged: AtlasNode = {
          id: n.id,
          plane: existing?.plane ?? cls.plane,
          stratum: existing?.stratum ?? cls.stratum,
          kind: n.kind,
          name: n.name.trim(),
          summary: n.summary.trim(),
          tags: Array.from(new Set([...(existing?.tags ?? []), ...n.tags])),
          principalAcl: existing?.principalAcl ?? cls.principalAcl,
          reinforcements: nextReinforcements,
          confidence: existing?.confidence ?? defaultConfidence(cls.stratum),
          sourceTrust: existing?.sourceTrust ?? "legacy_import",
          ...(n.steps?.length ? { steps: n.steps } : existing?.steps?.length ? { steps: existing.steps } : {}),
          ...(n.skillGateStatus ? { skillGateStatus: n.skillGateStatus } : existing?.skillGateStatus ? { skillGateStatus: existing.skillGateStatus } : {}),
          updatedAt: n.updatedAt || existing?.updatedAt || nowIso,
          ...(n.supersededAt ? { supersededAt: n.supersededAt } : {}),
        };
        this.nodes.set(merged.id, merged);
        this.persistNode(merged);
        this.syncSearchIndex(merged);
        importedNodes++;
      }
      for (const e of legacyEdges) {
        const fromN = this.nodes.get(e.from);
        const toN = this.nodes.get(e.to);
        const crossPlane = Boolean(fromN && toN && fromN.plane !== toN.plane);
        const edge: AtlasEdge = {
          id: e.id,
          plane: fromN?.plane ?? toN?.plane ?? "owner_life",
          from: e.from,
          relation: e.relation,
          to: e.to,
          weight: e.weight,
          source: e.source,
          ...(crossPlane ? { isMembraneEdge: true } : {}),
          validFrom: e.validFrom || nowIso,
          updatedAt: e.supersededAt || e.validFrom || nowIso,
          ...(e.supersededAt ? { supersededAt: e.supersededAt } : {}),
        };
        this.edges.set(edge.id, edge);
        this.persistEdge(edge);
        if (edge.supersededAt) supersededTargets.add(edge.to);
        importedEdges++;
      }
      for (const targetId of supersededTargets) {
        if (!this.hasActiveEdges(targetId)) this.markNodeSuperseded(targetId, undefined, nowIso);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.writeSnapshot();
    return { importedNodes, importedEdges };
  }

  private computeBm25Scores(queryTokens: string[]): Map<string, number> {
    if (!this.fts5Enabled) {
      return this.bm25.score(queryTokens);
    }
    const scores = new Map<string, number>();
    const unique = Array.from(new Set(queryTokens)).filter(Boolean);
    if (unique.length === 0) return scores;
    const matchExpr = unique.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
    try {
      const rows = this.db
        .prepare("SELECT node_id, bm25(atlas_fts) AS raw_score FROM atlas_fts WHERE atlas_fts MATCH ?")
        .all(matchExpr) as Array<{ node_id: string; raw_score: number }>;
      for (const row of rows) {
        scores.set(String(row.node_id), Math.max(0.01, -Number(row.raw_score)));
      }
    } catch {
      /* fallback to substring matching if FTS expression rejected */
    }
    return scores;
  }

  private resolveReferenceTimeMs(eligibleNodes: Iterable<AtlasNode>, nowIso?: string): number {
    if (nowIso) {
      const parsed = Date.parse(nowIso);
      if (Number.isFinite(parsed)) return parsed;
    }
    let maxUpdatedMs = -Infinity;
    for (const node of eligibleNodes) {
      const parsed = Date.parse(node.updatedAt);
      if (Number.isFinite(parsed) && parsed > maxUpdatedMs) {
        maxUpdatedMs = parsed;
      }
    }
    return Number.isFinite(maxUpdatedMs) ? maxUpdatedMs : Date.now();
  }

  recallStereoscopic(query: string, opts?: AtlasRecallOptions): AtlasRecallResult {
    const callerPrincipals = opts?.callerPrincipals ?? DEFAULT_CALLER_PRINCIPALS;
    const maxHops = opts?.maxHops ?? 2;
    const maxNodes = Math.max(0, opts?.maxNodes ?? 20);
    const minRank = opts?.minStratum ? STRATUM_RANK[opts.minStratum] : 0;
    const includeSuperseded = Boolean(opts?.includeSuperseded);
    const planesSet = opts?.planes?.length ? new Set<string>(opts.planes) : null;

    const eligibleNodes = new Map<string, AtlasNode>();
    for (const node of this.nodes.values()) {
      if (!includeSuperseded && (node.supersededAt || node.archivedAt)) continue;
      if (planesSet && !planesSet.has(node.plane)) continue;
      if (STRATUM_RANK[node.stratum] < minRank) continue;
      if (!hasPrincipalAccess(node.principalAcl, callerPrincipals)) continue;
      eligibleNodes.set(node.id, node);
    }

    if (maxNodes === 0 || eligibleNodes.size === 0) {
      return { nodes: [], edges: [], crossPlaneBridges: [], markdown: "" };
    }

    const eligibleEdges = Array.from(this.edges.values()).filter((e) => {
      if (!includeSuperseded && e.supersededAt) return false;
      if (!eligibleNodes.has(e.from) || !eligibleNodes.has(e.to)) return false;
      if (e.principalAcl?.length && !hasPrincipalAccess(e.principalAcl, callerPrincipals)) return false;
      return true;
    });

    const refTimeMs = this.resolveReferenceTimeMs(eligibleNodes.values(), opts?.nowIso);
    const temporalTrustMap = new Map<string, number>();
    for (const node of eligibleNodes.values()) {
      temporalTrustMap.set(node.id, computeTemporalTrustMultiplier(node, refTimeMs));
    }

    const trimmed = query.trim();
    const scoreMap = new Map<string, number>();
    if (!trimmed && !opts?.queryVector) {
      const ranked = Array.from(eligibleNodes.values())
        .map((n) => ({
          node: n,
          score: temporalTrustMap.get(n.id) ?? 1,
        }))
        .sort(
          (a, b) =>
            b.score - a.score ||
            b.node.updatedAt.localeCompare(a.node.updatedAt) ||
            a.node.id.localeCompare(b.node.id),
        )
        .slice(0, maxNodes);
      for (const item of ranked) scoreMap.set(item.node.id, item.score);
      return this.finalizeRecall(
        ranked.map((r) => r.node),
        eligibleEdges,
        scoreMap,
      );
    }

    const lexicalScoreMap = new Map<string, number>();
    if (trimmed) {
      const queryLower = trimmed.toLowerCase();
      const rawBaseTokens = tokenizeBaseForSearch(trimmed);
      const baseTokens = rawBaseTokens.length > 0 ? rawBaseTokens : [queryLower];
      const baseTokenSet = new Set<string>(baseTokens);
      const expandedTokens = tokenizeForSearch(trimmed);
      const synOnlyTokens = expandedTokens.filter((t) => !baseTokenSet.has(t));

      const bm25Base = this.computeBm25Scores(baseTokens);
      const bm25Syn =
        synOnlyTokens.length > 0 ? this.computeBm25Scores(synOnlyTokens) : new Map<string, number>();

      for (const node of eligibleNodes.values()) {
        const hay = `${node.id} ${node.name} ${node.summary} ${node.tags.join(" ")} ${(node.steps ?? []).join(" ")}`.toLowerCase();
        const bm25Raw = (bm25Base.get(node.id) ?? 0) + (bm25Syn.get(node.id) ?? 0) * 0.55;
        const directHits = baseTokens.filter((t) => hay.includes(t)).length;
        const synHits = synOnlyTokens.filter((t) => hay.includes(t)).length;
        const phraseBoost = hay.includes(queryLower) ? 1.5 : 0;
        const baseCoverage = baseTokens.length > 0 ? directHits / baseTokens.length : 0;
        const synBoost = synHits > 0 ? Math.min(1.0, synHits * 0.35) : 0;
        const lexicalScore = bm25Raw + baseCoverage * 1.2 + synBoost + phraseBoost;
        if (lexicalScore > 0) {
          lexicalScoreMap.set(node.id, lexicalScore);
        }
      }
    }

    const lexicalRankedIds = Array.from(lexicalScoreMap.entries())
      .sort((a, b) => {
        const diff = b[1] - a[1];
        if (Math.abs(diff) > 1e-9) return diff;
        const multDiff = (temporalTrustMap.get(b[0]) ?? 1) - (temporalTrustMap.get(a[0]) ?? 1);
        if (Math.abs(multDiff) > 1e-9) return multDiff;
        const nodeA = eligibleNodes.get(a[0])!;
        const nodeB = eligibleNodes.get(b[0])!;
        return nodeB.updatedAt.localeCompare(nodeA.updatedAt) || nodeA.id.localeCompare(nodeB.id);
      })
      .map(([id]) => id);

    let resolvedQueryVec: ArrayLike<number> | undefined = opts?.queryVector;
    if (!resolvedQueryVec && trimmed && this.embeddingPort?.embedSync) {
      try {
        resolvedQueryVec = this.embeddingPort.embedSync(trimmed);
      } catch {
        resolvedQueryVec = undefined;
      }
    }

    const vectorSimMap = new Map<string, number>();
    if (resolvedQueryVec && resolvedQueryVec.length > 0) {
      for (const node of eligibleNodes.values()) {
        const emb = this.embeddings.get(node.id);
        if (!emb || emb.dim !== resolvedQueryVec.length) continue;
        const sim = cosineSimilarity(resolvedQueryVec, emb.vector);
        if (sim > 0.15) {
          vectorSimMap.set(node.id, sim);
        }
      }
    }

    const vectorRankedIds = Array.from(vectorSimMap.entries())
      .sort((a, b) => {
        const diff = b[1] - a[1];
        if (Math.abs(diff) > 1e-9) return diff;
        const multDiff = (temporalTrustMap.get(b[0]) ?? 1) - (temporalTrustMap.get(a[0]) ?? 1);
        if (Math.abs(multDiff) > 1e-9) return multDiff;
        const nodeA = eligibleNodes.get(a[0])!;
        const nodeB = eligibleNodes.get(b[0])!;
        return nodeB.updatedAt.localeCompare(nodeA.updatedAt) || nodeA.id.localeCompare(nodeB.id);
      })
      .map(([id]) => id);

    const rrfK = opts?.rrfK && Number.isFinite(opts.rrfK) && opts.rrfK > 0 ? opts.rrfK : 60;
    const rankedLists: string[][] = [];
    if (lexicalRankedIds.length > 0) rankedLists.push(lexicalRankedIds);
    if (vectorRankedIds.length > 0) rankedLists.push(vectorRankedIds);

    const rrfMap = computeReciprocalRankFusion(rankedLists, rrfK);
    let maxLex = 1;
    for (const val of lexicalScoreMap.values()) {
      if (val > maxLex) maxLex = val;
    }

    const seedList: Array<{ node: AtlasNode; score: number }> = [];
    for (const [nodeId, rrfScore] of rrfMap.entries()) {
      const node = eligibleNodes.get(nodeId);
      if (!node) continue;
      const scaledRrf = rrfScore * (rrfK + 1);
      const normLex = (lexicalScoreMap.get(nodeId) ?? 0) / maxLex;
      const vecSim = vectorSimMap.get(nodeId) ?? 0;
      const signalStrength = Math.max(normLex, vecSim);
      const fusedRelevance = scaledRrf * (0.2 + 0.8 * signalStrength);
      const totalScore = fusedRelevance * (temporalTrustMap.get(nodeId) ?? 1);
      seedList.push({ node, score: totalScore });
    }
    seedList.sort(
      (a, b) =>
        b.score - a.score ||
        b.node.updatedAt.localeCompare(a.node.updatedAt) ||
        a.node.id.localeCompare(b.node.id),
    );

    const topSeedScore = seedList[0]?.score ?? 0;
    const visited = new Map<string, number>();
    let frontier: string[] = [];
    for (const seed of seedList.slice(0, maxNodes)) {
      visited.set(seed.node.id, seed.score);
      if (seed.score >= topSeedScore * 0.35) {
        frontier.push(seed.node.id);
      }
    }

    for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
      const frontierSet = new Set(frontier);
      const candidates: Array<{ neighborId: string; score: number }> = [];
      for (const edge of eligibleEdges) {
        let neighborId: string | undefined;
        let parentScore = 0;
        if (frontierSet.has(edge.from)) {
          neighborId = edge.to;
          parentScore = visited.get(edge.from) ?? 0;
        } else if (frontierSet.has(edge.to)) {
          neighborId = edge.from;
          parentScore = visited.get(edge.to) ?? 0;
        }
        if (!neighborId || parentScore <= 0) continue;
        const neighbor = eligibleNodes.get(neighborId);
        if (!neighbor) continue;
        const baseDecay = edge.relation === "derived_from_episode" ? 0.35 : 0.65;
        const edgeFactor = Math.min(1.0, Math.max(0.5, edge.weight));
        const rawHopScore = parentScore * baseDecay * (STRATUM_WEIGHT[neighbor.stratum] ?? 1.0) * edgeFactor;
        const hopScore = Math.min(parentScore * 0.92, rawHopScore);
        if (hopScore > (visited.get(neighborId) ?? 0)) {
          candidates.push({ neighborId, score: hopScore });
        }
      }
      candidates.sort((a, b) => b.score - a.score);
      const nextFrontier: string[] = [];
      for (const cand of candidates) {
        if (nextFrontier.length >= maxNodes) break;
        if (cand.score <= (visited.get(cand.neighborId) ?? 0)) continue;
        visited.set(cand.neighborId, cand.score);
        nextFrontier.push(cand.neighborId);
      }
      frontier = nextFrontier;
    }

    const selectedNodes = Array.from(visited.keys())
      .map((id) => eligibleNodes.get(id)!)
      .filter(Boolean)
      .sort(
        (a, b) =>
          (visited.get(b.id) ?? 0) - (visited.get(a.id) ?? 0) ||
          b.reinforcements - a.reinforcements ||
          b.updatedAt.localeCompare(a.updatedAt) ||
          a.id.localeCompare(b.id),
      )
      .slice(0, maxNodes);
    return this.finalizeRecall(selectedNodes, eligibleEdges, visited);
  }

  private finalizeRecall(
    nodes: AtlasNode[],
    eligibleEdges: AtlasEdge[],
    _scores: Map<string, number>,
  ): AtlasRecallResult {
    const selectedIds = new Set(nodes.map((n) => n.id));
    const edges = eligibleEdges.filter((e) => selectedIds.has(e.from) && selectedIds.has(e.to));
    const crossPlaneBridges = edges.filter(
      (e) =>
        !isOwnerOnlyProvenanceEdge(e) &&
        (Boolean(e.isMembraneEdge) || this.nodes.get(e.from)?.plane !== this.nodes.get(e.to)?.plane),
    );
    const lines: string[] = [];
    if (nodes.length > 0) {
      lines.push("## 立体记忆图谱关联实体 (Stereoscopic Atlas Entities)");
      for (const n of nodes) {
        lines.push(`- **[${n.plane} | ${n.stratum}] ${n.name}** (\`${n.id}\`, 巩固度:${n.reinforcements}): ${n.summary}`);
      }
    }
    if (edges.length > 0) {
      lines.push("", "## 活跃语义与半透膜关系 (Active Semantic & Membrane Relations)");
      for (const e of edges) {
        const fromName = this.nodes.get(e.from)?.name ?? e.from;
        const toName = this.nodes.get(e.to)?.name ?? e.to;
        const bridgeTag = e.isMembraneEdge ? ` [membrane${e.membranePolicy ? `:${e.membranePolicy}` : ""}]` : "";
        lines.push(`- ${fromName} —[\`${e.relation}\`]→ ${toName}${bridgeTag} *(source: ${e.source})*`);
      }
    }
    return { nodes, edges, crossPlaneBridges, markdown: lines.join("\n") };
  }

  getPlaneSummary(): AtlasPlaneSummary {
    const byPlane: AtlasPlaneSummary["byPlane"] = {};
    const byStratum: Record<EpistemicStratum, number> = {
      raw_episodic: 0,
      verified_fact: 0,
      digested_state: 0,
      crystallized_wisdom: 0,
    };
    let activeNodes = 0;
    let supersededNodes = 0;
    let archivedNodes = 0;
    for (const n of this.nodes.values()) {
      const bucket = (byPlane[n.plane] ??= { totalNodes: 0, activeNodes: 0, supersededNodes: 0, activeEdges: 0 });
      bucket.totalNodes++;
      if (n.supersededAt) {
        supersededNodes++;
        bucket.supersededNodes++;
      } else if (n.archivedAt) {
        archivedNodes++;
      } else {
        activeNodes++;
        bucket.activeNodes++;
        byStratum[n.stratum] = (byStratum[n.stratum] ?? 0) + 1;
      }
    }
    let activeEdges = 0;
    let supersededEdges = 0;
    let membraneBridgeCount = 0;
    for (const e of this.edges.values()) {
      if (e.supersededAt) {
        supersededEdges++;
      } else {
        activeEdges++;
        const bucket = (byPlane[e.plane] ??= { totalNodes: 0, activeNodes: 0, supersededNodes: 0, activeEdges: 0 });
        bucket.activeEdges++;
        const fromN = this.nodes.get(e.from);
        const toN = this.nodes.get(e.to);
        if (
          !isOwnerOnlyProvenanceEdge(e) &&
          (e.isMembraneEdge || (fromN && toN && fromN.plane !== toN.plane))
        ) {
          membraneBridgeCount++;
        }
      }
    }
    return {
      totalNodes: this.nodes.size,
      activeNodes,
      supersededNodes,
      archivedNodes,
      totalEdges: this.edges.size,
      activeEdges,
      supersededEdges,
      membraneBridgeCount,
      byPlane,
      byStratum,
    };
  }
}
