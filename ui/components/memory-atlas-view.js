import { useEffect, useMemo, useState } from "preact/hooks";
import { html, Switch } from "./ui.js";
import { api } from "../lib/api.js";
import { failed, toast } from "../lib/store.js";
import { has, t } from "../lib/i18n.js";

export const ATLAS_CX = 360;
export const ATLAS_CY = 260;
export const STRATUM_RADIUS = {
  crystallized_wisdom: 65,
  digested_state: 125,
  verified_fact: 185,
  raw_episodic: 235,
};
export const PLANE_ORDER = [
  "self_core",
  "owner_life",
  "relational",
  "domain_work",
  "meta_evolution",
];

export function planeGroupOf(plane) {
  const raw = String(plane || "");
  if (raw === "self_core") return "self_core";
  if (raw === "owner_life") return "owner_life";
  if (raw.startsWith("relational")) return "relational";
  if (raw.startsWith("domain_work")) return "domain_work";
  if (raw === "meta_evolution") return "meta_evolution";
  return "owner_life";
}

function shortLabel(text, max = 14) {
  const s = String(text || "").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function computeAtlasOrbitalLayout(nodes = [], edges = []) {
  const sectorTotal = (Math.PI * 2) / PLANE_ORDER.length;
  const sectorSpan = sectorTotal * 0.76;
  const startOffset = -Math.PI / 2;
  const buckets = new Map();

  for (const node of nodes) {
    const group = planeGroupOf(node?.plane);
    const stratum = STRATUM_RADIUS[node?.stratum] ? node.stratum : "verified_fact";
    const key = `${group}::${stratum}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ ...node, planeGroup: group, stratum });
  }

  const positionedNodes = [];
  const nodeMap = new Map();
  for (const [key, list] of buckets.entries()) {
    list.sort((a, b) => String(a.id || "").localeCompare(String(b.id || "")));
    const [group, stratum] = key.split("::");
    const planeIdx = Math.max(0, PLANE_ORDER.indexOf(group));
    const centerAngle = startOffset + planeIdx * sectorTotal;
    const sectorStart = centerAngle - sectorSpan / 2;
    const radius = STRATUM_RADIUS[stratum] ?? 185;

    list.forEach((node, idx) => {
      const frac = (idx + 1) / (list.length + 1);
      const angle = sectorStart + frac * sectorSpan;
      const x = Math.round((ATLAS_CX + radius * Math.cos(angle)) * 100) / 100;
      const y = Math.round((ATLAS_CY + radius * Math.sin(angle)) * 100) / 100;
      const positioned = { ...node, x, y, radius, angle };
      positionedNodes.push(positioned);
      nodeMap.set(positioned.id, positioned);
    });
  }
  positionedNodes.sort((a, b) => String(a.id || "").localeCompare(String(b.id || "")));

  const positionedEdges = [];
  for (const edge of edges) {
    const a = nodeMap.get(edge?.from);
    const b = nodeMap.get(edge?.to);
    if (!a || !b) continue;
    const isSuperseded = Boolean(edge?.supersededAt);
    const isMembrane = Boolean(edge?.isMembraneEdge);
    positionedEdges.push({
      ...edge,
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      kind: isSuperseded ? "superseded" : isMembrane ? "membrane" : "active",
    });
  }

  const sectorLabels = PLANE_ORDER.map((plane, idx) => {
    const angle = startOffset + idx * sectorTotal;
    const r = 250;
    return {
      plane,
      x: Math.round((ATLAS_CX + r * Math.cos(angle)) * 100) / 100,
      y: Math.round((ATLAS_CY + r * Math.sin(angle)) * 100) / 100,
    };
  });

  const orbits = Object.entries(STRATUM_RADIUS).map(([stratum, r]) => ({ stratum, r }));
  return {
    width: 720,
    height: 520,
    cx: ATLAS_CX,
    cy: ATLAS_CY,
    orbits,
    sectorLabels,
    positionedNodes,
    positionedEdges,
  };
}

const PLANE_PILLS = ["all", ...PLANE_ORDER];

export function MemoryAtlasScreen() {
  const [plane, setPlane] = useState("all");
  const [query, setQuery] = useState("");
  const [includeSuperseded, setIncludeSuperseded] = useState(false);
  const [data, setData] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [busy, setBusy] = useState(false);

  const loadAtlas = async () => {
    const params = new URLSearchParams({ includeGraph: "1", maxNodes: "80" });
    if (includeSuperseded) params.set("includeSuperseded", "1");
    if (plane !== "all") params.set("planes", plane);
    if (query.trim()) params.set("q", query.trim());
    const res = await api(`/steward/atlas?${params.toString()}`).catch((err) => {
      failed(err);
      return null;
    });
    if (res) setData(res);
  };

  useEffect(() => {
    void loadAtlas();
  }, [plane, includeSuperseded, query]);

  const rawGraph = useMemo(() => {
    const nodes = data?.graph?.nodes ?? data?.recall?.nodes ?? data?.nodes ?? [];
    const baseEdges = data?.graph?.edges ?? data?.recall?.edges ?? data?.edges ?? [];
    const bridges = data?.recall?.crossPlaneBridges ?? [];
    const seen = new Set();
    const edges = [];
    for (const e of [...baseEdges, ...bridges]) {
      const key = e?.id || `${e?.from}|${e?.relation}|${e?.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(e);
    }
    return { nodes, edges };
  }, [data]);

  const filtered = useMemo(() => {
    const qLower = query.trim().toLowerCase();
    const nodes = rawGraph.nodes.filter((n) => {
      if (!n) return false;
      if (!includeSuperseded && (n.supersededAt || n.archivedAt)) return false;
      if (plane !== "all" && planeGroupOf(n.plane) !== plane) return false;
      if (qLower) {
        const hay = `${n.name || ""} ${n.summary || ""} ${n.kind || ""} ${n.plane || ""} ${(n.tags || []).join(" ")}`.toLowerCase();
        if (!hay.includes(qLower)) return false;
      }
      return true;
    });
    const visibleIds = new Set(nodes.map((n) => n.id));
    const edges = rawGraph.edges.filter((e) => {
      if (!e || !visibleIds.has(e.from) || !visibleIds.has(e.to)) return false;
      if (!includeSuperseded && e.supersededAt) return false;
      return true;
    });
    return { nodes, edges };
  }, [rawGraph, plane, includeSuperseded, query]);

  const layout = useMemo(
    () => computeAtlasOrbitalLayout(filtered.nodes, filtered.edges),
    [filtered.nodes, filtered.edges],
  );

  const selectedNode = useMemo(
    () => layout.positionedNodes.find((n) => n.id === selectedId) || null,
    [layout.positionedNodes, selectedId],
  );

  const relatedEdges = useMemo(() => {
    if (!selectedNode) return [];
    return filtered.edges.filter((e) => e.from === selectedNode.id || e.to === selectedNode.id);
  }, [filtered.edges, selectedNode]);

  const mutateNode = async (action, extra = {}) => {
    if (!selectedNode || busy) return;
    setBusy(true);
    try {
      await api("/steward/atlas/mutate", {
        method: "POST",
        body: { action, nodeId: selectedNode.id, ...extra },
      });
      toast(t("steward.atlas.mutatedToast"));
      await loadAtlas();
    } catch (err) {
      failed(err);
    } finally {
      setBusy(false);
    }
  };

  const summary = data?.summary;
  const stats = {
    nodes: summary?.activeNodes ?? filtered.nodes.filter((n) => !n.supersededAt).length,
    edges: summary?.activeEdges ?? filtered.edges.filter((e) => !e.supersededAt).length,
    bridges: summary?.membraneBridgeCount ?? filtered.edges.filter((e) => e.isMembraneEdge).length,
    superseded: summary?.supersededNodes ?? 0,
  };

  const stratumLabel = (s) => (has(`steward.atlas.strata.${s}`) ? t(`steward.atlas.strata.${s}`) : s);
  const planeLabel = (p) => (has(`steward.atlas.planes.${p}`) ? t(`steward.atlas.planes.${p}`) : p);

  return html`<section class="sg-page" data-screen="memory-atlas">
    <div class="sg-page-inner">
      <header class="sg-head">
        <div>
          <h1 class="sg-title">${t("steward.atlas.title")}</h1>
          <p class="sg-sub">${t("steward.atlas.subtitle")}</p>
        </div>
        <div class="sg-head-actions">
          <button type="button" class="btn sm" disabled=${busy} onClick=${loadAtlas}>${t("steward.atlas.refreshBtn")}</button>
          <button type="button" class="btn sm" onClick=${() => { location.hash = "/steward"; }}>${t("steward.atlas.backToHub")}</button>
        </div>
      </header>

      <div class="sg-atlas-toolbar">
        <div class="sg-atlas-pills">
          ${PLANE_PILLS.map((p) => html`<button
            key=${p}
            type="button"
            class=${`btn sm${plane === p ? " primary" : ""}`}
            aria-pressed=${plane === p}
            onClick=${() => setPlane(p)}>${planeLabel(p)}</button>`)}
        </div>
        <div class="sg-atlas-controls">
          <input class="field sg-atlas-search" value=${query} onInput=${(e) => setQuery(e.target.value)}
            placeholder=${t("steward.atlas.searchPlaceholder")} />
          <label class="sg-quiet-label">
            <span>${t("steward.atlas.includeSuperseded")}</span>
            <${Switch} label=${t("steward.atlas.includeSuperseded")} value=${includeSuperseded} onChange=${setIncludeSuperseded} />
          </label>
        </div>
      </div>

      <div class="sg-card-hint">${t("steward.atlas.statsLine", stats)}</div>

      <div class="sg-atlas-layout">
        <div class="sg-atlas-stage">
          <svg class="sg-atlas-svg" viewBox="0 0 720 520" role="img" aria-label=${t("steward.atlas.svgAriaLabel")}>
            ${layout.orbits.map((o) => html`<circle key=${o.stratum} class="sg-atlas-orbit" cx=${layout.cx} cy=${layout.cy} r=${o.r} />`)}
            ${layout.sectorLabels.map((s) => html`<text key=${s.plane} class="sg-atlas-sector-label" x=${s.x} y=${s.y} text-anchor="middle">${planeLabel(s.plane)}</text>`)}
            ${layout.positionedEdges.map((e) => {
              const cls = e.kind === "superseded"
                ? "sg-atlas-edge-superseded"
                : e.kind === "membrane"
                  ? "sg-atlas-edge-membrane"
                  : "sg-atlas-edge-active";
              return html`<line key=${e.id || `${e.from}-${e.relation}-${e.to}`} class=${cls} x1=${e.x1} y1=${e.y1} x2=${e.x2} y2=${e.y2} />`;
            })}
            ${layout.positionedNodes.map((n) => {
              const r = n.stratum === "crystallized_wisdom" ? 9 : n.stratum === "digested_state" ? 7 : 6;
              const cls = `sg-atlas-node${n.id === selectedId ? " sel" : ""}${n.supersededAt ? " superseded" : ""}${n.stratum === "crystallized_wisdom" ? " s3" : ""}`;
              return html`<g key=${n.id} class=${cls} transform=${`translate(${n.x}, ${n.y})`}
                tabindex="0" role="button" aria-label=${n.name} aria-pressed=${n.id === selectedId}
                onClick=${() => setSelectedId(n.id)}
                onKeyDown=${(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    setSelectedId(n.id);
                  }
                }}>
                <circle r=${r} />
                <text class="sg-atlas-label" y="18" text-anchor="middle">${shortLabel(n.name)}</text>
              </g>`;
            })}
          </svg>
          ${layout.positionedNodes.length === 0 && html`<div class="sg-card-hint">${t("steward.atlas.emptyHint")}</div>`}
          <div class="sg-atlas-legend">
            <span class="sg-atlas-legend-item"><span class="sg-atlas-swatch-active"></span>${t("steward.atlas.legendActive")}</span>
            <span class="sg-atlas-legend-item"><span class="sg-atlas-swatch-superseded"></span>${t("steward.atlas.legendSuperseded")}</span>
            <span class="sg-atlas-legend-item"><span class="sg-atlas-swatch-membrane"></span>${t("steward.atlas.legendMembrane")}</span>
          </div>
        </div>

        <aside class="sg-card">
          <div class="sg-card-head">
            <span class="sg-card-title">${t("steward.atlas.inspectorTitle")}</span>
          </div>
          ${!selectedNode && html`<div class="sg-card-hint">${t("steward.atlas.inspectorEmpty")}</div>`}
          ${selectedNode && html`<div class="sg-item-block">
            <div class="sg-card-head">
              <strong>${selectedNode.name}</strong>
              <span class="badge">${selectedNode.kind}</span>
            </div>
            <div class="sg-draft-box">${selectedNode.summary}</div>
            <div class="sg-atlas-meta-row">
              <span class="sg-card-hint">${t("steward.atlas.fields.plane")}</span>
              <span>${selectedNode.plane}</span>
            </div>
            <div class="sg-atlas-meta-row">
              <span class="sg-card-hint">${t("steward.atlas.fields.stratum")}</span>
              <span>${stratumLabel(selectedNode.stratum)}</span>
            </div>
            <div class="sg-atlas-meta-row">
              <span class="sg-card-hint">${t("steward.atlas.fields.confidence")}</span>
              <span>${Math.round((selectedNode.confidence ?? 0) * 100)}%</span>
            </div>
            <div class="sg-atlas-meta-row">
              <span class="sg-card-hint">${t("steward.atlas.fields.reinforcements")}</span>
              <span>${selectedNode.reinforcements ?? 0}</span>
            </div>
            <div class="sg-atlas-meta-row">
              <span class="sg-card-hint">${t("steward.atlas.fields.sourceTrust")}</span>
              <span>${selectedNode.sourceTrust || "-"}</span>
            </div>
            <div class="sg-atlas-meta-row">
              <span class="sg-card-hint">${t("steward.atlas.fields.acl")}</span>
              <span>${(selectedNode.principalAcl || []).join(", ") || "-"}</span>
            </div>
            ${selectedNode.supersededAt && html`<div class="sg-atlas-meta-row">
              <span class="sg-card-hint">${t("steward.atlas.fields.supersededInfo")}</span>
              <span>${selectedNode.supersededBy || selectedNode.supersededAt}</span>
            </div>`}
            <div class="sg-atlas-meta-row">
              <span class="sg-card-hint">${t("steward.atlas.fields.relations", { count: relatedEdges.length })}</span>
            </div>
            ${relatedEdges.slice(0, 6).map((e) => html`<div key=${e.id || `${e.from}-${e.relation}-${e.to}`} class="sg-card-hint">
              ${e.from} — ${e.relation} → ${e.to}
            </div>`)}
            ${!selectedNode.supersededAt && html`<div class="sg-actions">
              ${selectedNode.stratum !== "crystallized_wisdom" && html`<button type="button" class="btn sm primary" disabled=${busy}
                onClick=${() => mutateNode("promote_stratum", { stratum: "crystallized_wisdom" })}>${t("steward.atlas.btnPromote")}</button>`}
              <button type="button" class="btn sm" disabled=${busy}
                onClick=${() => mutateNode("supersede_node")}>${t("steward.atlas.btnSupersede")}</button>
              <button type="button" class="btn sm danger" disabled=${busy}
                onClick=${() => mutateNode("tombstone_node")}>${t("steward.atlas.btnTombstone")}</button>
            </div>`}
          </div>`}
        </aside>
      </div>
    </div>
  </section>`;
}
