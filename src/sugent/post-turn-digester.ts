/**
 * Turn 结束记忆增量沉淀器 (src/sugent/post-turn-digester.ts)
 *
 * 在每轮对话结束后执行：
 * 1. 离线确定性提取（mode: "none" 下依然可用）：捕获主人显式指令并沉淀到 KG 与记忆条目，同时巩固复用的工作流节点；
 * 2. 可选后台 LLM 归档：运行 REVIEW_SYSTEM 与（按需）KG_EXTRACTION_SYSTEM 增量写入知识图谱；
 * 3. 防抖调度与密钥拦截：通过 looksSecret 拦截敏感内容，定时器自动 unref() 且支持 dispose() 清理。
 */
import crypto from "node:crypto";
import { looksSecret } from "../agent/memory.js";
import { REVIEW_SYSTEM, parseReview } from "../agent/steward.js";
import { KG_EXTRACTION_SYSTEM, parseKGDelta, type KGDelta, type SugentKnowledgeGraph } from "./knowledge-graph.js";
import type { StewardshipLedger } from "./stewardship-ledger.js";

export interface PostTurnDigesterOptions {
  knowledgeGraph: SugentKnowledgeGraph;
  ledger: StewardshipLedger;
  onNodeDelta?: (delta: KGDelta, channel: string) => void;
  syncMemoryEntry?: (text: string, topic?: string) => void;
  completeFn?: (system: string, user: string) => Promise<string>;
  debounceMs?: number;
  nowIso?: () => string;
}

export interface PostTurnInput {
  channel: string;
  peerId: string;
  userText: string;
  assistantReply: string;
}

export interface PostTurnDigestResult {
  skippedSecret: boolean;
  deterministicNodes: number;
  deterministicReinforcedWorkflows: number;
  reviewAdded: number;
  reviewRemoved: number;
  deepExtractedNodes: number;
  deepExtractedEdges: number;
}

const DIRECTIVE_PATTERNS: readonly RegExp[] = [
  /^(?:(?:以后)?请?记住|以后(?:请)?(?:统一|固定)|我的偏好是)[：:，,\s]*(.+)$/,
  /^(切记(?:不要|别|勿|不能).*)$/,
];

const WORKFLOW_CUE_RE = /(?:步骤|流程|先.*再|工作流|sop|workflow|pipeline|npm run|git )/i;
const COMPLETION_CUE_RE = /(?:完成|搞定|跑通|已执行|执行完毕|已按|按.*执行|验证通过|succeeded|completed|finished|done)/i;
const GENERIC_TAGS = new Set(["post-turn", "workflow", "preference", "review", "ops"]);

function extractDeterministicDirectives(userText: string): Array<{ text: string; isWorkflow: boolean }> {
  const out: Array<{ text: string; isWorkflow: boolean }> = [];
  const seen = new Set<string>();
  const clauses = userText
    .split(/[。\n；;！？!?]+/)
    .map((c) => c.trim())
    .filter((c) => c.length >= 4);

  for (const clause of clauses) {
    let extracted: string | undefined;
    for (const re of DIRECTIVE_PATTERNS) {
      const m = re.exec(clause);
      if (m?.[1]?.trim()) {
        extracted = clause.startsWith("以后") || clause.startsWith("切记") ? clause : m[1].trim();
        break;
      }
    }
    if (!extracted || extracted.length < 3 || seen.has(extracted)) continue;
    seen.add(extracted);
    out.push({ text: extracted, isWorkflow: WORKFLOW_CUE_RE.test(extracted) });
  }
  return out;
}

export class PostTurnDigester {
  private readonly opts: PostTurnDigesterOptions;
  private readonly debounceMs: number;
  private readonly nowIsoFn: () => string;
  private readonly pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: PostTurnDigesterOptions) {
    this.opts = opts;
    this.debounceMs = Math.max(0, Math.trunc(opts.debounceMs ?? 1500));
    this.nowIsoFn = opts.nowIso ?? (() => new Date().toISOString());
  }

  scheduleTurnDigest(turn: PostTurnInput): void {
    const key = `${turn.channel}:${turn.peerId}`;
    const existing = this.pendingTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.pendingTimers.delete(key);
      void this.digestTurnNow(turn).catch(() => {});
    }, this.debounceMs);
    timer.unref?.();
    this.pendingTimers.set(key, timer);
  }

  dispose(): void {
    for (const timer of this.pendingTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingTimers.clear();
  }

  async digestTurnNow(turn: PostTurnInput): Promise<PostTurnDigestResult> {
    const now = this.nowIsoFn();
    const userSecret = looksSecret(turn.userText);
    const replySecret = looksSecret(turn.assistantReply);
    if (userSecret || replySecret) {
      return {
        skippedSecret: true,
        deterministicNodes: 0,
        deterministicReinforcedWorkflows: 0,
        reviewAdded: 0,
        reviewRemoved: 0,
        deepExtractedNodes: 0,
        deepExtractedEdges: 0,
      };
    }

    let deterministicNodes = 0;
    let deterministicReinforcedWorkflows = 0;
    const createdNodeIds = new Set<string>();
    const directives = extractDeterministicDirectives(turn.userText);
    if (directives.length > 0) {
      const nodes: NonNullable<KGDelta["nodes"]> = [];
      const edges: NonNullable<KGDelta["edges"]> = [];
      const scopeId = `scope:${turn.channel}:${turn.peerId}`;
      for (const dir of directives) {
        if (looksSecret(dir.text)) continue;
        const hash = crypto.createHash("sha256").update(dir.text, "utf8").digest("hex").slice(0, 10);
        const nodeId = dir.isWorkflow ? `wf:turn-${hash}` : `pref:turn-${hash}`;
        createdNodeIds.add(nodeId);
        const steps = dir.isWorkflow
          ? dir.text.split(/[，,；;。]|然后|接着|再/).map((s) => s.trim()).filter((s) => s.length >= 2)
          : undefined;
        nodes.push({
          id: nodeId,
          kind: dir.isWorkflow ? "workflow" : "preference",
          name: dir.text.slice(0, 32),
          summary: dir.text,
          tags: ["post-turn", turn.channel, dir.isWorkflow ? "workflow" : "preference"],
          ...(steps?.length ? { steps } : {}),
        });
        edges.push({
          from: scopeId,
          relation: dir.isWorkflow ? "uses_workflow" : "prefers",
          to: nodeId,
          source: "post_turn_deterministic",
        });
        this.opts.syncMemoryEntry?.(dir.text, dir.isWorkflow ? "workflow" : "preference");
      }
      if (nodes.length > 0) {
        const delta: KGDelta = { nodes, edges };
        const applied = this.opts.knowledgeGraph.applyDelta(delta, now);
        deterministicNodes = applied.upsertedNodes;
        this.opts.onNodeDelta?.(delta, turn.channel);
      }
    }

    const combined = `${turn.userText}\n${turn.assistantReply}`;
    if (COMPLETION_CUE_RE.test(combined)) {
      const combinedLower = combined.toLowerCase();
      for (const wf of this.opts.knowledgeGraph.allNodes()) {
        if (wf.kind !== "workflow" || wf.supersededAt || createdNodeIds.has(wf.id)) continue;
        const nameMatch = wf.name.trim().length >= 2 && combinedLower.includes(wf.name.trim().toLowerCase());
        const idMatch = combinedLower.includes(wf.id.toLowerCase());
        const tagMatch = wf.tags.some((t) => {
          const clean = t.trim().toLowerCase();
          return clean.length >= 2 && !GENERIC_TAGS.has(clean) && combinedLower.includes(clean);
        });
        if (nameMatch || idMatch || tagMatch) {
          const reinforceDelta: KGDelta = {
            nodes: [
              {
                id: wf.id,
                kind: "workflow",
                name: wf.name,
                summary: wf.summary,
                tags: wf.tags,
                reinforcements: 1,
                ...(wf.steps ? { steps: wf.steps } : {}),
              },
            ],
          };
          this.opts.knowledgeGraph.applyDelta(reinforceDelta, now);
          this.opts.onNodeDelta?.(reinforceDelta, turn.channel);
          deterministicReinforcedWorkflows += 1;
        }
      }
    }

    let reviewAdded = 0;
    let reviewRemoved = 0;
    let deepExtractedNodes = 0;
    let deepExtractedEdges = 0;

    if (this.opts.completeFn) {
      const transcript = [
        `channel: ${turn.channel}`,
        `peer: ${turn.peerId}`,
        `user: ${turn.userText}`,
        `assistant: ${turn.assistantReply}`,
      ].join("\n");
      try {
        const reviewRaw = await this.opts.completeFn(REVIEW_SYSTEM, transcript);
        const reviewOps = parseReview(reviewRaw);
        const safeAdd = reviewOps.add.filter((item) => !looksSecret(item.text));
        if (safeAdd.length > 0 || reviewOps.remove.length > 0) {
          const scopeKey = `${turn.channel}:${turn.peerId}`;
          this.opts.knowledgeGraph.ingestMemoryReviewOps(
            { add: safeAdd, remove: reviewOps.remove },
            scopeKey,
            now,
          );
          for (const item of safeAdd) {
            this.opts.syncMemoryEntry?.(item.text, item.topic);
          }
          reviewAdded = safeAdd.length;
          reviewRemoved = reviewOps.remove.length;
        }
      } catch {
        /* ignore optional review error */
      }

      if (process.env.SUGENT_KG_DEEP_EXTRACT === "1" || WORKFLOW_CUE_RE.test(transcript)) {
        try {
          const kgRaw = await this.opts.completeFn(KG_EXTRACTION_SYSTEM, transcript);
          const kgDelta = parseKGDelta(kgRaw);
          const safeNodes = (kgDelta.nodes ?? []).filter((n) => !looksSecret(n.summary) && !looksSecret(n.name));
          const safeDelta: KGDelta = {
            nodes: safeNodes,
            edges: kgDelta.edges ?? [],
          };
          if (safeNodes.length > 0 || (safeDelta.edges?.length ?? 0) > 0) {
            const applied = this.opts.knowledgeGraph.applyDelta(safeDelta, now);
            deepExtractedNodes = applied.upsertedNodes;
            deepExtractedEdges = applied.upsertedEdges;
            this.opts.onNodeDelta?.(safeDelta, turn.channel);
          }
        } catch {
          /* ignore optional deep extract error */
        }
      }
    }

    return {
      skippedSecret: false,
      deterministicNodes,
      deterministicReinforcedWorkflows,
      reviewAdded,
      reviewRemoved,
      deepExtractedNodes,
      deepExtractedEdges,
    };
  }
}