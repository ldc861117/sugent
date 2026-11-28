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
import type {
  AtlasEdgeInput,
  AtlasNodeInput,
  EpistemicStratum,
  GraphPlaneId,
  PrincipalId,
  SourceTrust,
  StereoscopicAtlas,
} from "./stereoscopic-atlas.js";

export interface PostTurnDigesterOptions {
  knowledgeGraph: SugentKnowledgeGraph;
  ledger: StewardshipLedger;
  atlas?: StereoscopicAtlas;
  resolveTurnPlane?: (turn: PostTurnInput) => {
    plane: GraphPlaneId;
    principalAcl?: PrincipalId[];
    sourceTrust?: SourceTrust;
  };
  assessorDigestHook?: (turn: PostTurnInput, nowIso: string) => Promise<void> | void;
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
  plane?: GraphPlaneId;
  projectKey?: string;
  episodeId?: string;
}

export interface PostTurnDigestResult {
  skippedSecret: boolean;
  deterministicNodes: number;
  deterministicReinforcedWorkflows: number;
  reviewAdded: number;
  reviewRemoved: number;
  deepExtractedNodes: number;
  deepExtractedEdges: number;
  nativeAtlasNodes: number;
  nativeAtlasEdges: number;
  episodeAnchorId?: string;
}

const DIRECTIVE_PATTERNS: readonly RegExp[] = [
  /^(?:(?:以后)?请?记住|以后(?:请)?(?:统一|固定)|我的偏好是)[：:，,\s]*(.+)$/,
  /^(切记(?:不要|别|勿|不能).*)$/,
];

const WORKFLOW_CUE_RE = /(?:步骤|流程|先.*再|工作流|sop|workflow|pipeline|npm run|git )/i;
const COMPLETION_CUE_RE = /(?:完成|搞定|跑通|已执行|执行完毕|已按|按.*执行|验证通过|succeeded|completed|finished|done)/i;
const GENERIC_TAGS = new Set(["post-turn", "workflow", "preference", "review", "ops"]);

interface ResolvedPlaneMeta {
  plane: GraphPlaneId;
  principalAcl: PrincipalId[];
  sourceTrust?: SourceTrust;
}

function defaultPrincipalsForPlane(plane: GraphPlaneId): PrincipalId[] {
  if (plane === "owner_life") return ["owner:M"];
  if (plane.startsWith("relational:peer:")) return ["owner:M", "sugent_self"];
  return ["sugent_self", "owner:M"];
}

function isExternalPeerTurn(turn: PostTurnInput): boolean {
  return (
    turn.channel === "concierge" ||
    turn.channel === "wechat_envoy" ||
    turn.peerId.startsWith("peer:")
  );
}

function resolvePrimaryTurnPlane(
  turn: PostTurnInput,
  hookResult?: { plane: GraphPlaneId; principalAcl?: PrincipalId[]; sourceTrust?: SourceTrust },
): ResolvedPlaneMeta {
  if (turn.plane) {
    return {
      plane: turn.plane,
      principalAcl: hookResult?.principalAcl?.length
        ? [...hookResult.principalAcl]
        : defaultPrincipalsForPlane(turn.plane),
      ...(hookResult?.sourceTrust ? { sourceTrust: hookResult.sourceTrust } : {}),
    };
  }
  if (hookResult?.plane) {
    return {
      plane: hookResult.plane,
      principalAcl: hookResult.principalAcl?.length
        ? [...hookResult.principalAcl]
        : defaultPrincipalsForPlane(hookResult.plane),
      ...(hookResult.sourceTrust ? { sourceTrust: hookResult.sourceTrust } : {}),
    };
  }
  if (turn.projectKey && turn.projectKey.trim()) {
    return {
      plane: `domain_work:${turn.projectKey.trim()}`,
      principalAcl: ["sugent_self", "owner:M"],
    };
  }
  if (isExternalPeerTurn(turn)) {
    const slug = turn.peerId.replace(/^peer:/, "").trim() || "external";
    return {
      plane: `relational:peer:${slug}`,
      principalAcl: ["owner:M", "sugent_self"],
    };
  }
  return {
    plane: "owner_life",
    principalAcl: ["owner:M"],
  };
}

function resolveNodePlane(
  turn: PostTurnInput,
  nodeId: string,
  kind: string,
  hookResult?: { plane: GraphPlaneId; principalAcl?: PrincipalId[]; sourceTrust?: SourceTrust },
): ResolvedPlaneMeta {
  if (turn.plane || hookResult?.plane || (turn.projectKey && turn.projectKey.trim()) || isExternalPeerTurn(turn)) {
    return resolvePrimaryTurnPlane(turn, hookResult);
  }
  if (nodeId.startsWith("wf:") || kind === "workflow") {
    return {
      plane: "meta_evolution",
      principalAcl: ["sugent_self", "owner:M"],
    };
  }
  if (nodeId.startsWith("proj:") || nodeId.startsWith("repo:") || kind === "project" || kind === "repo") {
    return {
      plane: "domain_work:default",
      principalAcl: ["sugent_self", "owner:M"],
    };
  }
  return {
    plane: "owner_life",
    principalAcl: ["owner:M"],
  };
}

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
        nativeAtlasNodes: 0,
        nativeAtlasEdges: 0,
      };
    }

    const atlas = this.opts.atlas;
    const hookPlane = atlas ? this.opts.resolveTurnPlane?.(turn) : undefined;
    const preTurnReinf = new Map<string, number>();
    const snapshotPreReinf = (id: string): number => {
      if (!atlas) return 0;
      if (!preTurnReinf.has(id)) {
        preTurnReinf.set(id, atlas.getNode(id)?.reinforcements ?? 0);
      }
      return preTurnReinf.get(id)!;
    };
    const stagedAtlasNodes = new Map<string, { input: AtlasNodeInput; targetReinf: number }>();
    const stagedSemanticEdges: AtlasEdgeInput[] = [];

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
        const prevAtlasReinf = snapshotPreReinf(nodeId);
        createdNodeIds.add(nodeId);
        const steps = dir.isWorkflow
          ? dir.text.split(/[，,；;。]|然后|接着|再/).map((s) => s.trim()).filter((s) => s.length >= 2)
          : undefined;
        const kind = dir.isWorkflow ? "workflow" : "preference";
        const tags = ["post-turn", turn.channel, dir.isWorkflow ? "workflow" : "preference"];
        nodes.push({
          id: nodeId,
          kind,
          name: dir.text.slice(0, 32),
          summary: dir.text,
          tags,
          ...(steps?.length ? { steps } : {}),
        });
        edges.push({
          from: scopeId,
          relation: dir.isWorkflow ? "uses_workflow" : "prefers",
          to: nodeId,
          source: "post_turn_deterministic",
        });
        this.opts.syncMemoryEntry?.(dir.text, dir.isWorkflow ? "workflow" : "preference");

        if (atlas) {
          const resolved = resolveNodePlane(turn, nodeId, kind, hookPlane);
          const targetReinf = prevAtlasReinf + 1;
          const stratum: EpistemicStratum =
            dir.isWorkflow && targetReinf >= 3 ? "crystallized_wisdom" : "verified_fact";
          stagedAtlasNodes.set(nodeId, {
            targetReinf,
            input: {
              id: nodeId,
              plane: resolved.plane,
              stratum,
              kind,
              name: dir.text.slice(0, 32),
              summary: dir.text,
              tags,
              principalAcl: resolved.principalAcl,
              sourceTrust: resolved.sourceTrust ?? "owner_confirmed",
              ...(steps?.length ? { steps } : {}),
            },
          });
        }
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
      const reinforcedIds = new Set<string>();
      const matchesWorkflow = (wf: { id: string; name: string; tags: string[] }): boolean => {
        const nameMatch = wf.name.trim().length >= 2 && combinedLower.includes(wf.name.trim().toLowerCase());
        const idMatch = combinedLower.includes(wf.id.toLowerCase());
        const tagMatch = wf.tags.some((t) => {
          const clean = t.trim().toLowerCase();
          return clean.length >= 2 && !GENERIC_TAGS.has(clean) && combinedLower.includes(clean);
        });
        return nameMatch || idMatch || tagMatch;
      };

      for (const wf of this.opts.knowledgeGraph.allNodes()) {
        if (wf.kind !== "workflow" || wf.supersededAt || createdNodeIds.has(wf.id)) continue;
        if (matchesWorkflow(wf)) {
          const prevAtlasReinf = snapshotPreReinf(wf.id);
          const preAtlasNode = atlas?.getNode(wf.id);
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
          reinforcedIds.add(wf.id);

          if (atlas) {
            const updatedKgWf = this.opts.knowledgeGraph.getNode(wf.id);
            const targetReinf = Math.max(updatedKgWf?.reinforcements ?? 0, prevAtlasReinf + 1);
            const resolved = preAtlasNode
              ? { plane: preAtlasNode.plane, principalAcl: preAtlasNode.principalAcl }
              : resolveNodePlane(turn, wf.id, "workflow", hookPlane);
            stagedAtlasNodes.set(wf.id, {
              targetReinf,
              input: {
                id: wf.id,
                plane: resolved.plane,
                stratum: targetReinf >= 3 ? "crystallized_wisdom" : "verified_fact",
                kind: "workflow",
                name: wf.name,
                summary: wf.summary,
                tags: wf.tags,
                principalAcl: resolved.principalAcl,
                sourceTrust: "owner_confirmed",
                ...(wf.steps?.length ? { steps: wf.steps } : {}),
                ...(updatedKgWf?.skillGateStatus ? { skillGateStatus: updatedKgWf.skillGateStatus } : {}),
              },
            });
          }
        }
      }

      if (atlas) {
        for (const aWf of atlas.allNodes()) {
          if (aWf.kind !== "workflow" || createdNodeIds.has(aWf.id) || reinforcedIds.has(aWf.id)) continue;
          if (matchesWorkflow(aWf)) {
            const prevAtlasReinf = snapshotPreReinf(aWf.id);
            const targetReinf = prevAtlasReinf + 1;
            deterministicReinforcedWorkflows += 1;
            reinforcedIds.add(aWf.id);
            stagedAtlasNodes.set(aWf.id, {
              targetReinf,
              input: {
                id: aWf.id,
                plane: aWf.plane,
                stratum: targetReinf >= 3 ? "crystallized_wisdom" : "verified_fact",
                kind: "workflow",
                name: aWf.name,
                summary: aWf.summary,
                tags: aWf.tags,
                principalAcl: aWf.principalAcl,
                sourceTrust: "owner_confirmed",
                ...(aWf.steps?.length ? { steps: aWf.steps } : {}),
                ...(aWf.skillGateStatus ? { skillGateStatus: aWf.skillGateStatus } : {}),
              },
            });
          }
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
            if (atlas) {
              const slug =
                item.text
                  .toLowerCase()
                  .replace(/[^\p{L}\p{N}]+/gu, "-")
                  .replace(/^-+|-+$/g, "")
                  .slice(0, 32) || "fact";
              const topicTag = item.topic ? item.topic.trim().toLowerCase() : "general";
              const nodeId = `mem:${topicTag}:${slug}`;
              const prevAtlasReinf = snapshotPreReinf(nodeId);
              const existingNode = atlas.getNode(nodeId);
              const isWorkflow = WORKFLOW_CUE_RE.test(item.text);
              const kind = isWorkflow ? "workflow" : "preference";
              const resolved = resolveNodePlane(turn, nodeId, kind, hookPlane);
              const steps = isWorkflow
                ? item.text.split(/[；;。]/).map((s) => s.trim()).filter(Boolean)
                : undefined;
              if (!stagedAtlasNodes.has(nodeId)) {
                stagedAtlasNodes.set(nodeId, {
                  targetReinf: prevAtlasReinf + 1,
                  input: {
                    id: nodeId,
                    plane: resolved.plane,
                    stratum:
                      existingNode?.stratum === "crystallized_wisdom"
                        ? "crystallized_wisdom"
                        : "verified_fact",
                    kind,
                    name: item.topic ? `${item.topic}: ${item.text.slice(0, 24)}` : item.text.slice(0, 28),
                    summary: item.text,
                    tags: [topicTag, "review"],
                    principalAcl: resolved.principalAcl,
                    sourceTrust: resolved.sourceTrust ?? "llm_inferred",
                    ...(steps?.length ? { steps } : {}),
                  },
                });
              }
            }
          }
          if (atlas && reviewOps.remove.length > 0) {
            const removeTerms = reviewOps.remove
              .map((r) => String(r ?? "").trim().toLowerCase())
              .filter(Boolean);
            if (removeTerms.length > 0) {
              for (const aNode of atlas.allNodes()) {
                if (!aNode.id.startsWith("mem:")) continue;
                const hay = `${aNode.id} ${aNode.name} ${aNode.summary}`.toLowerCase();
                if (removeTerms.some((term) => hay.includes(term))) {
                  atlas.supersedeNode(aNode.id, undefined, now);
                }
              }
            }
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
          const safeEdges = (kgDelta.edges ?? []).filter((e) => !looksSecret(`${e.relation} ${e.source}`));
          const safeDelta: KGDelta = {
            nodes: safeNodes,
            edges: safeEdges,
          };
          if (safeNodes.length > 0 || safeEdges.length > 0) {
            const preNodeReinf = new Map<string, number>();
            const preNodeExisting = new Map<string, ReturnType<StereoscopicAtlas["getNode"]>>();
            if (atlas) {
              for (const n of safeNodes) {
                preNodeReinf.set(n.id, snapshotPreReinf(n.id));
                preNodeExisting.set(n.id, atlas.getNode(n.id));
              }
            }
            const applied = this.opts.knowledgeGraph.applyDelta(safeDelta, now);
            deepExtractedNodes = applied.upsertedNodes;
            deepExtractedEdges = applied.upsertedEdges;
            this.opts.onNodeDelta?.(safeDelta, turn.channel);

            if (atlas) {
              for (const n of safeNodes) {
                if (stagedAtlasNodes.has(n.id)) continue;
                const prevReinf = preNodeReinf.get(n.id) ?? 0;
                const existingNode = preNodeExisting.get(n.id);
                const resolved = resolveNodePlane(turn, n.id, n.kind, hookPlane);
                stagedAtlasNodes.set(n.id, {
                  targetReinf: prevReinf + 1,
                  input: {
                    id: n.id,
                    plane: resolved.plane,
                    stratum:
                      existingNode?.stratum === "crystallized_wisdom"
                        ? "crystallized_wisdom"
                        : "verified_fact",
                    kind: n.kind,
                    name: n.name,
                    summary: n.summary,
                    tags: n.tags,
                    principalAcl: resolved.principalAcl,
                    sourceTrust: resolved.sourceTrust ?? "llm_inferred",
                    ...(n.steps?.length ? { steps: n.steps } : {}),
                    ...(n.skillGateStatus ? { skillGateStatus: n.skillGateStatus } : {}),
                  },
                });
              }
              for (const e of safeEdges) {
                stagedSemanticEdges.push({
                  from: e.from,
                  relation: e.relation,
                  to: e.to,
                  weight: e.weight,
                  source: e.source,
                  exclusive: e.exclusive,
                });
              }
            }
          }
        } catch {
          /* ignore optional deep extract error */
        }
      }
    }

    let nativeAtlasNodes = 0;
    let nativeAtlasEdges = 0;
    let episodeAnchorId: string | undefined;

    if (atlas && stagedAtlasNodes.size > 0) {
      const epHash = crypto
        .createHash("sha256")
        .update(`${turn.channel}:${turn.peerId}:${now}:${turn.userText}`, "utf8")
        .digest("hex")
        .slice(0, 12);
      const baseEpisodeId = turn.episodeId?.trim() || `ep:turn:${epHash}`;
      const planesTouched = Array.from(
        new Set(Array.from(stagedAtlasNodes.values()).map((entry) => entry.input.plane)),
      );
      const primaryPlane = resolvePrimaryTurnPlane(turn, hookPlane).plane;
      const anchorPrimaryPlane = planesTouched.includes(primaryPlane) ? primaryPlane : planesTouched[0]!;

      const atlasNodesToApply: AtlasNodeInput[] = [];
      const provenanceEdges: AtlasEdgeInput[] = [];

      for (const plane of planesTouched) {
        const existingBaseEp = atlas.getNode(baseEpisodeId);
        const canUseBase =
          plane === anchorPrimaryPlane && (!existingBaseEp || existingBaseEp.plane === plane);
        const epIdForPlane = canUseBase ? baseEpisodeId : `${baseEpisodeId}:${plane}`;
        if (!episodeAnchorId || canUseBase) {
          episodeAnchorId = epIdForPlane;
        }
        const existingEp = atlas.getNode(epIdForPlane);
        atlasNodesToApply.push({
          id: epIdForPlane,
          plane,
          stratum: "raw_episodic",
          kind: "concept",
          name: `${turn.channel} 对话原话锚点 (${now.slice(0, 10)})`,
          summary: `U: ${turn.userText.slice(0, 120)} | A: ${turn.assistantReply.slice(0, 120)}`,
          tags: ["episode_anchor", `channel:${turn.channel}`, `at:${now}`],
          principalAcl: ["owner:M"],
          sourceTrust: "deterministic_gate",
          reinforcements: existingEp ? 0 : 1,
        });

        for (const { input, targetReinf } of stagedAtlasNodes.values()) {
          if (input.plane !== plane) continue;
          const curReinf = atlas.getNode(input.id)?.reinforcements ?? 0;
          atlasNodesToApply.push({
            ...input,
            reinforcements: Math.max(0, targetReinf - curReinf),
          });
          provenanceEdges.push({
            plane,
            from: input.id,
            relation: "derived_from_episode",
            to: epIdForPlane,
            source: "post_turn_digester",
            principalAcl: ["owner:M"],
          });
        }
      }

      try {
        const appliedAtlas = atlas.applyDelta(
          {
            nodes: atlasNodesToApply,
            edges: [...provenanceEdges, ...stagedSemanticEdges],
          },
          now,
        );
        nativeAtlasNodes = appliedAtlas.upsertedNodes;
        nativeAtlasEdges = appliedAtlas.upsertedEdges;
      } catch {
        try {
          const fallbackApplied = atlas.applyDelta(
            {
              nodes: atlasNodesToApply,
              edges: provenanceEdges,
            },
            now,
          );
          nativeAtlasNodes = fallbackApplied.upsertedNodes;
          nativeAtlasEdges = fallbackApplied.upsertedEdges;
        } catch {
          /* ignore atlas ingestion edge error */
        }
      }
    }

    if (this.opts.assessorDigestHook) {
      try {
        await this.opts.assessorDigestHook(turn, now);
      } catch {
        /* ignore optional assessor hook failure */
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
      nativeAtlasNodes,
      nativeAtlasEdges,
      ...(episodeAnchorId ? { episodeAnchorId } : {}),
    };
  }
}