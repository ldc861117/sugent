import type { SugentKnowledgeGraph } from "./knowledge-graph.js";

export interface KnowledgeGraphNodeLike {
  id: string;
  label: string;
  kind: string;
  peerScope?: string;
  summary: string;
  confidentialTokens?: readonly string[];
}

export interface KnowledgeGraphEdgeLike {
  from: string;
  to: string;
  relation: string;
}

export interface TwoHopSubgraphSnapshot {
  nodes: readonly KnowledgeGraphNodeLike[];
  edges: readonly KnowledgeGraphEdgeLike[];
}

export interface KnowledgeGraphRecallPort {
  recallTwoHopSubgraph(anchorEntityId: string): TwoHopSubgraphSnapshot;
}

export interface PeerIsolatedSubgraph {
  peerId: string;
  allowedNodes: KnowledgeGraphNodeLike[];
  allowedEdges: KnowledgeGraphEdgeLike[];
  crossPeerCanaryTokens: string[];
  briefDigest: string;
}

export function createSugentGraphRecallAdapter(
  graph: SugentKnowledgeGraph,
  extractor: (graphInstance: SugentKnowledgeGraph, anchorId: string) => TwoHopSubgraphSnapshot,
): KnowledgeGraphRecallPort {
  return {
    recallTwoHopSubgraph(anchorEntityId: string): TwoHopSubgraphSnapshot {
      return extractor(graph, anchorEntityId);
    },
  };
}

export function recallPeerIsolatedSubgraph(
  graphPort: KnowledgeGraphRecallPort,
  peerId: string,
): PeerIsolatedSubgraph {
  const anchorId = `peer:${peerId}`;
  const rawSnapshot = graphPort.recallTwoHopSubgraph(anchorId);

  const allowedNodes: KnowledgeGraphNodeLike[] = [];
  const allowedNodeIds = new Set<string>();
  const canarySet = new Set<string>();

  for (const node of rawSnapshot.nodes) {
    const isCurrentPeer = node.peerScope === peerId;
    const isPublicCatalog = node.peerScope === "public_catalog";

    if (isCurrentPeer || isPublicCatalog) {
      allowedNodes.push(node);
      allowedNodeIds.add(node.id);
    } else {
      if (node.label.trim().length >= 2) {
        canarySet.add(node.label.trim());
      }
      for (const token of node.confidentialTokens ?? []) {
        if (token.trim().length >= 2) {
          canarySet.add(token.trim());
        }
      }
    }
  }

  const allowedEdges = rawSnapshot.edges.filter(
    (edge) => allowedNodeIds.has(edge.from) && allowedNodeIds.has(edge.to),
  );

  const briefDigest =
    allowedNodes.length === 0
      ? "暂无历史建档记录（首次来访联系人）"
      : allowedNodes.map((n) => `[${n.kind}] ${n.label}：${n.summary}`).join("；");

  return {
    peerId,
    allowedNodes,
    allowedEdges,
    crossPeerCanaryTokens: [...canarySet],
    briefDigest,
  };
}
