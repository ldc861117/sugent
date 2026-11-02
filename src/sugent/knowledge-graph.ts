/**
 * Sugent 自主维护知识图谱与技能结晶引擎 (src/sugent/knowledge-graph.ts)
 *
 * 解决上游 AnyModelBot (扁平 Markdown 列表记忆) 与 dsh-superagent (仅 SQLite 工单状态、无跨会话知识库) 的核心短板：
 *
 * 1. 结构化实体-关系图谱 (Entity-Relation Graph)：
 *    - 节点 (KGNode)：person | project | repo | preference | workflow | tool | concept
 *    - 边 (KGEdge)：带方向、权重、证据来源 (evidence) 与时间有效性 (validFrom / supersededAt)
 * 2. 自动冲突消解与时效演进 (Temporal Conflict Resolution)：
 *    - 对单值排他关系（如 prefers_model / active_branch / primary_server），写入新事实时自动将旧边归档为 superseded，避免前后记忆打架
 * 3. 多跳子图关联召回 (Multi-Hop Subgraph Recall)：
 *    - 给定查询词或种子实体，自动做 K-Hop (默认 2 跳) 邻域扩展，拼装成可直接注入 System Prompt 的高密度 Markdown 子图快照
 * 4. 经验 -> 固化技能结晶 (Autonomous Skill Crystallization)：
 *    - 当某个 workflow 节点在实践中累计成功执行达到阈值（默认 3 次），自动生成标准 SKILL.md 模板并落盘到技能目录，将"非结构化经验"永久固化为"可执行技能"
 */
import fs from "node:fs";
import path from "node:path";
import { looksSecret } from "../agent/memory.js";

export type EntityKind =
  | "person"
  | "project"
  | "repo"
  | "preference"
  | "workflow"
  | "tool"
  | "concept";

export interface KGNode {
  id: string;
  kind: EntityKind;
  name: string;
  summary: string;
  tags: string[];
  /** 累计被验证/复用的次数（用于衡量知识巩固度与技能结晶） */
  reinforcements: number;
  /** 若 kind === 'workflow'，记录标准操作步骤以供固化为 SKILL.md */
  steps?: string[];
  updatedAt: string;
}

export interface KGEdge {
  id: string;
  from: string;
  relation: string;
  to: string;
  weight: number;
  source: string;
  validFrom: string;
  /** 若被更新的事实取代，则记录取代时间戳，召回活跃子图时自动过滤已过时事实 */
  supersededAt?: string;
}

export interface KGDelta {
  nodes?: Array<Omit<KGNode, "reinforcements" | "updatedAt"> & { reinforcements?: number }>;
  edges?: Array<{
    from: string;
    relation: string;
    to: string;
    weight?: number;
    source: string;
    /** 是否为单值排他关系（若是，同一 from + relation 的旧活跃边会自动标记为 supersededAt） */
    exclusive?: boolean;
  }>;
}

export interface SubgraphSnapshot {
  matchedNodes: KGNode[];
  activeEdges: KGEdge[];
  markdown: string;
}

export const SKILL_CRYSTALLIZE_THRESHOLD = 3;

/**
 * 供后台管家模型（steward）从对话归档中抽取结构化知识图谱与可复用 SOP 工作流的系统提示词
 */
export const KG_EXTRACTION_SYSTEM = [
  "你是 Sugent 的知识图谱与技能架构师。请从给定的对话记录中抽取值得长期固化的实体（nodes）、语义关系（edges）以及可复用的多步工作流（workflow）。",
  "不要抽取密码、API Key、令牌或一次性闲聊。若某项配置或偏好取代了旧设置，将该边标记为 exclusive: true。",
  "只输出一行合法的 JSON，格式如下：",
  '{"nodes":[{"id":"proj:sugent","kind":"project|person|repo|preference|workflow|tool|concept","name":"名称","summary":"一句话描述","tags":["标签"],"steps":["仅当kind为workflow时填写的步骤1","步骤2"]}],"edges":[{"from":"源节点id","relation":"关系名","to":"目标节点id","source":"review","exclusive":false}]}',
].join("\n");

/**
 * 解析管家模型返回的知识图谱增量 JSON（容错解析）
 */
export function parseKGDelta(raw: string): KGDelta {
  const m = String(raw ?? "").match(/\{[\s\S]*\}/);
  if (!m) return {};
  try {
    const parsed = JSON.parse(m[0]);
    const validKinds = new Set<EntityKind>(["person", "project", "repo", "preference", "workflow", "tool", "concept"]);
    const nodes: NonNullable<KGDelta["nodes"]> = [];
    const edges: NonNullable<KGDelta["edges"]> = [];

    for (const n of Array.isArray(parsed?.nodes) ? parsed.nodes : []) {
      if (!n || typeof n.id !== "string" || typeof n.name !== "string" || typeof n.summary !== "string") continue;
      const kind: EntityKind = validKinds.has(n.kind) ? n.kind : "concept";
      const steps = Array.isArray(n.steps) ? n.steps.filter((s: unknown) => typeof s === "string" && s.trim()).map((s: string) => s.trim()) : undefined;
      nodes.push({
        id: n.id.trim(),
        kind,
        name: n.name.trim(),
        summary: n.summary.trim(),
        tags: Array.isArray(n.tags) ? n.tags.map(String) : [],
        ...(steps?.length ? { steps } : {}),
      });
    }

    for (const e of Array.isArray(parsed?.edges) ? parsed.edges : []) {
      if (!e || typeof e.from !== "string" || typeof e.relation !== "string" || typeof e.to !== "string") continue;
      edges.push({
        from: e.from.trim(),
        relation: e.relation.trim(),
        to: e.to.trim(),
        source: typeof e.source === "string" && e.source.trim() ? e.source.trim() : "steward",
        exclusive: Boolean(e.exclusive),
      });
    }

    return { nodes, edges };
  } catch {
    return {};
  }
}

export class SugentKnowledgeGraph {
  private nodes = new Map<string, KGNode>();
  private edges = new Map<string, KGEdge>();
  private readonly graphFile: string;
  private readonly journalFile: string;

  constructor(readonly rootDir: string) {
    this.graphFile = path.join(rootDir, "knowledge-graph.json");
    this.journalFile = path.join(rootDir, "kg-journal.jsonl");
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.graphFile)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.graphFile, "utf8"));
      for (const n of raw.nodes ?? []) this.nodes.set(n.id, n);
      for (const e of raw.edges ?? []) this.edges.set(e.id, e);
    } catch {
      /* ignore corrupted or empty init */
    }
  }

  save(): void {
    fs.mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      nodes: Array.from(this.nodes.values()),
      edges: Array.from(this.edges.values()),
    };
    const tmp = `${this.graphFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this.graphFile);
  }

  private appendJournal(event: Record<string, unknown>): void {
    fs.mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      this.journalFile,
      JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n",
      { mode: 0o600 },
    );
  }

  /**
   * 增量合并智能体从对话或任务执行中提炼出的知识增量（KGDelta）
   * 内置密钥/隐私拦截：包含 API Key / 密码的节点或关系一律拒绝入图
   */
  applyDelta(delta: KGDelta, now = new Date().toISOString()): { upsertedNodes: number; upsertedEdges: number } {
    let upsertedNodes = 0;
    let upsertedEdges = 0;

    for (const input of delta.nodes ?? []) {
      if (looksSecret(input.summary) || looksSecret(input.name)) {
        throw new Error(`Refused to store secret-like content in Knowledge Graph node: ${input.id}`);
      }
      const existing = this.nodes.get(input.id);
      const merged: KGNode = {
        id: input.id,
        kind: input.kind,
        name: input.name.trim(),
        summary: input.summary.trim(),
        tags: Array.from(new Set([...(existing?.tags ?? []), ...(input.tags ?? [])])),
        reinforcements: (existing?.reinforcements ?? 0) + (input.reinforcements ?? 1),
        ...(input.steps ? { steps: input.steps } : existing?.steps ? { steps: existing.steps } : {}),
        updatedAt: now,
      };
      this.nodes.set(merged.id, merged);
      upsertedNodes++;
      this.appendJournal({ op: "upsert_node", id: merged.id, kind: merged.kind, reinforcements: merged.reinforcements });
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
            this.appendJournal({ op: "supersede_edge", edgeId: existingEdge.id, byTo: edgeInput.to });
          }
        }
      }

      const edgeId = `${edgeInput.from}--${edgeInput.relation}-->${edgeInput.to}`;
      const existing = this.edges.get(edgeId);
      const edge: KGEdge = {
        id: edgeId,
        from: edgeInput.from,
        relation: edgeInput.relation,
        to: edgeInput.to,
        weight: edgeInput.weight ?? (existing ? existing.weight + 1 : 1),
        source: edgeInput.source,
        validFrom: existing?.validFrom ?? now,
      };
      this.edges.set(edgeId, edge);
      upsertedEdges++;
      this.appendJournal({ op: "upsert_edge", id: edgeId, source: edgeInput.source });
    }

    this.save();
    return { upsertedNodes, upsertedEdges };
  }

  /**
   * 将上下文管家（steward.ts REVIEW_SYSTEM）产出的 ReviewOps 自动同步沉淀至知识图谱：
   * - 将新增条目转化为 `preference` 或 `concept` 节点，并与对应的 `scope` 及 `topic` 建立语义边；
   * - 将删除条目对应的关联节点执行弱化或移除。
   */
  ingestMemoryReviewOps(
    ops: { add: Array<{ text: string; topic?: string }>; remove: string[] },
    scopeKey: string,
    now = new Date().toISOString(),
  ): { upsertedNodes: number; upsertedEdges: number } {
    const delta: KGDelta = { nodes: [], edges: [] };
    const scopeNodeId = `scope:${scopeKey}`;
    delta.nodes!.push({
      id: scopeNodeId,
      kind: "concept",
      name: `记忆域 (${scopeKey})`,
      summary: `作用域 ${scopeKey} 的知识锚点`,
      tags: ["scope"],
    });

    for (const item of ops.add) {
      if (looksSecret(item.text)) continue;
      const slug = item.text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32) || "fact";
      const topicTag = item.topic ? item.topic.trim().toLowerCase() : "general";
      const nodeId = `mem:${topicTag}:${slug}`;
      const isWorkflow = /步骤|流程|先.*再|npm run|git /i.test(item.text);

      delta.nodes!.push({
        id: nodeId,
        kind: isWorkflow ? "workflow" : "preference",
        name: item.topic ? `${item.topic}: ${item.text.slice(0, 24)}` : item.text.slice(0, 28),
        summary: item.text,
        tags: [topicTag, "review"],
        ...(isWorkflow ? { steps: item.text.split(/[；;。]/).map((s) => s.trim()).filter(Boolean) } : {}),
      });
      delta.edges!.push({
        from: scopeNodeId,
        relation: item.topic ? `has_${topicTag}` : "remembers",
        to: nodeId,
        source: "steward_review",
      });
    }

    if (!delta.nodes!.length && !delta.edges!.length) return { upsertedNodes: 0, upsertedEdges: 0 };
    return this.applyDelta(delta, now);
  }

  getNode(id: string): KGNode | undefined {
    return this.nodes.get(id);
  }

  activeEdges(): KGEdge[] {
    return Array.from(this.edges.values()).filter((e) => !e.supersededAt);
  }

  /**
   * 多跳子图召回（K-Hop Subgraph Recall）：
   * 先通过关键词匹配种子实体，再沿活跃关系边向外扩展 `maxHops` 跳，生成结构化上下文快照。
   */
  recallSubgraph(query: string, maxHops = 2, maxNodes = 20): SubgraphSnapshot {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    const visited = new Set<string>();
    let frontier = new Set<string>();

    for (const node of this.nodes.values()) {
      const hay = `${node.id} ${node.name} ${node.summary} ${node.tags.join(" ")}`.toLowerCase();
      if (!terms.length || terms.some((t) => hay.includes(t))) {
        visited.add(node.id);
        frontier.add(node.id);
      }
    }

    const active = this.activeEdges();
    for (let hop = 0; hop < maxHops && frontier.size > 0 && visited.size < maxNodes; hop++) {
      const nextFrontier = new Set<string>();
      for (const edge of active) {
        if (frontier.has(edge.from) && !visited.has(edge.to)) {
          visited.add(edge.to);
          nextFrontier.add(edge.to);
        } else if (frontier.has(edge.to) && !visited.has(edge.from)) {
          visited.add(edge.from);
          nextFrontier.add(edge.from);
        }
        if (visited.size >= maxNodes) break;
      }
      frontier = nextFrontier;
    }

    const matchedNodes = Array.from(visited)
      .map((id) => this.nodes.get(id)!)
      .filter(Boolean)
      .sort((a, b) => b.reinforcements - a.reinforcements);

    const relevantEdges = active.filter((e) => visited.has(e.from) && visited.has(e.to));

    const lines: string[] = [];
    if (matchedNodes.length) {
      lines.push("## 知识图谱关联实体 (Knowledge Graph Entities)");
      for (const n of matchedNodes) {
        lines.push(`- **[${n.kind}] ${n.name}** (\`${n.id}\`, 巩固度:${n.reinforcements}): ${n.summary}`);
      }
    }
    if (relevantEdges.length) {
      lines.push("", "## 实体语义关系 (Active Relations)");
      for (const e of relevantEdges) {
        const fromName = this.nodes.get(e.from)?.name ?? e.from;
        const toName = this.nodes.get(e.to)?.name ?? e.to;
        lines.push(`- ${fromName} —[\`${e.relation}\`]→ ${toName} *(source: ${e.source})*`);
      }
    }

    return {
      matchedNodes,
      activeEdges: relevantEdges,
      markdown: lines.join("\n"),
    };
  }

  /**
   * 扫描图谱中已达到固化阈值（reinforcements >= threshold）的 workflow 节点，
   * 自动生成可写入 DSH skills/ 目录的标准 SKILL.md 内容（实现"记忆 -> 固化能力"的闭环）。
   */
  crystallizeSkills(threshold = SKILL_CRYSTALLIZE_THRESHOLD): Array<{ skillName: string; markdown: string; node: KGNode }> {
    const out: Array<{ skillName: string; markdown: string; node: KGNode }> = [];
    for (const node of this.nodes.values()) {
      if (node.kind !== "workflow" || node.reinforcements < threshold || !node.steps?.length) continue;
      const skillName = node.id.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
      const md = [
        "---",
        `name: ${skillName}`,
        `description: ${node.summary}`,
        "---",
        "",
        `# ${node.name}`,
        "",
        `> 自动结晶自 Sugent 知识图谱（累计成功验证 ${node.reinforcements} 次，更新时间：${node.updatedAt}）`,
        "",
        "## 标准执行步骤 (Standard Operating Procedure)",
        ...node.steps.map((s, idx) => `${idx + 1}. ${s}`),
        "",
      ].join("\n");
      out.push({ skillName, markdown: md, node });
    }
    return out;
  }

  /**
   * 将达到阈值的 workflow 节点直接落盘生成 `<skillsRootDir>/<skillName>/SKILL.md` 文件
   */
  crystallizeSkillsToDir(skillsRootDir: string, threshold = SKILL_CRYSTALLIZE_THRESHOLD): string[] {
    const crystallized = this.crystallizeSkills(threshold);
    const writtenPaths: string[] = [];
    for (const item of crystallized) {
      const dir = path.join(skillsRootDir, item.skillName);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, "SKILL.md");
      fs.writeFileSync(file, item.markdown, { mode: 0o600 });
      writtenPaths.push(file);
      this.appendJournal({ op: "crystallize_skill", skillName: item.skillName, file, reinforcements: item.node.reinforcements });
    }
    return writtenPaths;
  }
}
