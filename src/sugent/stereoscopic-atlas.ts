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

export interface AtlasRecallOptions {
  planes?: GraphPlaneId[];
  minStratum?: EpistemicStratum;
  callerPrincipals?: PrincipalId[];
  maxHops?: number;
  maxNodes?: number;
  includeSuperseded?: boolean;
}

export interface AtlasRecallResult {
  nodes: AtlasNode[];
  edges: AtlasEdge[];
  crossPlaneBridges: AtlasEdge[];
  markdown: string;
}

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

const DEFAULT_CALLER_PRINCIPALS: PrincipalId[] = ["sugent_self", "owner:M"];

const CJK_STOP_RE =
  /(请问|一下|什么情况|是什么|怎么|情况|目前|现在|关于|能不能|可以|帮我|的|了|吗|呢|啊|吧)/g;

export function tokenizeForSearch(text: string): string[] {
  const lower = String(text ?? "").toLowerCase().trim();
  if (!lower) return [];
  const tokens: string[] = [];
  for (const seg of lower.split(/[\s,.;:!?，。；：！？、()（）【】\[\]"'“”‘’]+/).filter(Boolean)) {
    const asciiMatches = seg.match(/[a-z0-9_.:/-]{2,}/g) ?? [];
    for (const tok of asciiMatches) {
      tokens.push(tok);
      const subParts = tok.split(/[.:/_-]+/).filter((p) => p.length >= 2);
      if (subParts.length > 1) tokens.push(...subParts);
    }
    const cjkClean = seg.replace(CJK_STOP_RE, " ");
    for (const cjkSeg of cjkClean.split(/\s+/).filter(Boolean)) {
      const chars = Array.from(cjkSeg).filter((ch) => /\p{Script=Han}/u.test(ch));
      if (chars.length === 1) {
        tokens.push(chars[0]!);
      } else {
        for (let i = 0; i + 1 < chars.length; i++) {
          tokens.push(chars[i]! + chars[i + 1]!);
        }
      }
    }
  }
  return tokens;
}

function buildSearchText(node: AtlasNode): string {
  const raw = `${node.id} ${node.plane} ${node.kind} ${node.name} ${node.summary} ${node.tags.join(" ")} ${(node.steps ?? []).join(" ")}`;
  return tokenizeForSearch(raw).join(" ");
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
  private nodes = new Map<string, AtlasNode>();
  private edges = new Map<string, AtlasEdge>();
  private closed = false;

  constructor(rootDirOrMemory: string) {
    this.isMemory = rootDirOrMemory === ":memory:";
    this.rootDir = this.isMemory ? ":memory:" : path.resolve(rootDirOrMemory);
    this.dbPath = this.isMemory ? ":memory:" : path.join(this.rootDir, "atlas.db");
    this.snapshotPath = this.isMemory ? "" : path.join(this.rootDir, "atlas-snapshot.json");
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
          this.bm25.upsert(node.id, tokenizeForSearch(buildSearchText(node)));
        }
      }
    }
    for (const row of edgeRows) {
      const edge = this.rowToEdge(row);
      this.edges.set(edge.id, edge);
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

  private removeFromSearchIndex(nodeId: string): void {
    if (this.fts5Enabled) {
      this.db.prepare("DELETE FROM atlas_fts WHERE node_id = ?").run(nodeId);
    } else {
      this.db.prepare("DELETE FROM atlas_search_index WHERE node_id = ?").run(nodeId);
      this.bm25.remove(nodeId);
    }
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
      if (isCrossPlane && (fromNode?.stratum === "raw_episodic" || toNode?.stratum === "raw_episodic")) {
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
        if (edge.isMembraneEdge || (fromN && toN && fromN.plane !== toN.plane)) {
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
        const isMembrane = Boolean(edgeInput.isMembraneEdge) || crossPlane;
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

    const trimmed = query.trim();
    const scoreMap = new Map<string, number>();
    if (!trimmed) {
      const ranked = Array.from(eligibleNodes.values())
        .map((n) => ({
          node: n,
          score: STRATUM_WEIGHT[n.stratum] * (1 + Math.log1p(n.reinforcements) * 0.2),
        }))
        .sort((a, b) => b.score - a.score || b.node.updatedAt.localeCompare(a.node.updatedAt) || a.node.id.localeCompare(b.node.id))
        .slice(0, maxNodes);
      for (const item of ranked) scoreMap.set(item.node.id, item.score);
      return this.finalizeRecall(ranked.map((r) => r.node), eligibleEdges, scoreMap);
    }

    const queryLower = trimmed.toLowerCase();
    const rawTokens = tokenizeForSearch(trimmed);
    const queryTokens = rawTokens.length > 0 ? rawTokens : [queryLower];
    const bm25Scores = this.computeBm25Scores(queryTokens);

    const seedList: Array<{ node: AtlasNode; score: number }> = [];
    for (const node of eligibleNodes.values()) {
      const hay = `${node.id} ${node.name} ${node.summary} ${node.tags.join(" ")} ${(node.steps ?? []).join(" ")}`.toLowerCase();
      const bm25Raw = bm25Scores.get(node.id) ?? 0;
      const termHits = queryTokens.filter((t) => hay.includes(t)).length;
      const phraseBoost = hay.includes(queryLower) ? 1.5 : 0;
      const termCoverage = queryTokens.length > 0 ? termHits / queryTokens.length : 0;
      const lexicalScore = bm25Raw + termCoverage * 1.2 + phraseBoost;
      if (lexicalScore <= 0) continue;
      const totalScore = lexicalScore * STRATUM_WEIGHT[node.stratum] * (1 + Math.log1p(node.reinforcements) * 0.2);
      seedList.push({ node, score: totalScore });
    }
    seedList.sort((a, b) => b.score - a.score || b.node.updatedAt.localeCompare(a.node.updatedAt) || a.node.id.localeCompare(b.node.id));

    const visited = new Map<string, number>();
    let frontier: string[] = [];
    for (const seed of seedList.slice(0, maxNodes)) {
      visited.set(seed.node.id, seed.score);
      frontier.push(seed.node.id);
    }

    for (let hop = 0; hop < maxHops && frontier.length > 0 && visited.size < maxNodes; hop++) {
      const frontierSet = new Set(frontier);
      const candidates: Array<{ neighborId: string; score: number }> = [];
      for (const edge of eligibleEdges) {
        let neighborId: string | undefined;
        let parentScore = 0;
        if (frontierSet.has(edge.from) && !visited.has(edge.to)) {
          neighborId = edge.to;
          parentScore = visited.get(edge.from) ?? 1;
        } else if (frontierSet.has(edge.to) && !visited.has(edge.from)) {
          neighborId = edge.from;
          parentScore = visited.get(edge.to) ?? 1;
        }
        if (!neighborId) continue;
        const neighbor = eligibleNodes.get(neighborId);
        if (!neighbor) continue;
        const hopScore = parentScore * 0.65 * STRATUM_WEIGHT[neighbor.stratum] * Math.max(0.5, edge.weight);
        candidates.push({ neighborId, score: hopScore });
      }
      candidates.sort((a, b) => b.score - a.score);
      const nextFrontier: string[] = [];
      for (const cand of candidates) {
        if (visited.size >= maxNodes) break;
        if (visited.has(cand.neighborId)) continue;
        visited.set(cand.neighborId, cand.score);
        nextFrontier.push(cand.neighborId);
      }
      frontier = nextFrontier;
    }

    const selectedNodes = Array.from(visited.keys())
      .map((id) => eligibleNodes.get(id)!)
      .filter(Boolean)
      .sort((a, b) => (visited.get(b.id) ?? 0) - (visited.get(a.id) ?? 0) || b.reinforcements - a.reinforcements)
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
      (e) => Boolean(e.isMembraneEdge) || this.nodes.get(e.from)?.plane !== this.nodes.get(e.to)?.plane,
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
        if (e.isMembraneEdge || (fromN && toN && fromN.plane !== toN.plane)) {
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
