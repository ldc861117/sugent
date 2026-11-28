import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error UI locale modules are uncompiled ES modules
import zhSteward from "../ui/locales/zh-CN/steward.js";
// @ts-expect-error UI locale modules are uncompiled ES modules
import enSteward from "../ui/locales/en/steward.js";

let ATLAS_CX: number;
let ATLAS_CY: number;
let STRATUM_RADIUS: Record<string, number>;
let computeAtlasOrbitalLayout: (nodes?: any[], edges?: any[]) => any;
let planeGroupOf: (plane?: string) => string;
let installedFakeWindow = false;

beforeAll(async () => {
  if (typeof globalThis.window === "undefined") {
    installedFakeWindow = true;
    (globalThis as any).window = {
      matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
      addEventListener: () => {},
      removeEventListener: () => {},
      location: { hash: "", search: "", pathname: "/" },
    };
  }
  // @ts-expect-error UI modules are uncompiled ES modules
  const mod = await import("../ui/components/memory-atlas-view.js");
  ATLAS_CX = mod.ATLAS_CX;
  ATLAS_CY = mod.ATLAS_CY;
  STRATUM_RADIUS = mod.STRATUM_RADIUS;
  computeAtlasOrbitalLayout = mod.computeAtlasOrbitalLayout;
  planeGroupOf = mod.planeGroupOf;
});

afterAll(() => {
  if (installedFakeWindow) {
    delete (globalThis as any).window;
  }
});

const ROOT = path.resolve(import.meta.dirname, "..");

function collectLeafKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") keys.push(next);
    else if (v && typeof v === "object") keys.push(...collectLeafKeys(v as Record<string, unknown>, next));
  }
  return keys.sort();
}

describe("Lane F (P4.5b): Stereoscopic Memory Atlas & Mind Journal UI", () => {
  it("computes deterministic orbital coordinates across 5 planes and 4 strata without overlapping", () => {
    const nodes = [
      { id: "n-s3-self", plane: "self_core", stratum: "crystallized_wisdom", name: "Charter" },
      { id: "n-s2-owner", plane: "owner_life", stratum: "digested_state", name: "Energy" },
      { id: "n-s1-rel-1", plane: "relational:duo:andy-gillna", stratum: "verified_fact", name: "Anchor A" },
      { id: "n-s1-rel-2", plane: "relational:peer:alex", stratum: "verified_fact", name: "Anchor B" },
      { id: "n-s0-work", plane: "domain_work:repo:sugent", stratum: "raw_episodic", name: "Commit Log" },
      { id: "n-s3-meta", plane: "meta_evolution", stratum: "crystallized_wisdom", name: "SIM Pattern" },
    ];
    const edges = [
      { id: "e1", from: "n-s3-self", to: "n-s1-rel-1", relation: "guides", isMembraneEdge: true },
      { id: "e2", from: "n-s2-owner", to: "n-s0-work", relation: "tracks", supersededAt: "2026-11-20T00:00:00Z" },
      { id: "e3", from: "n-s3-self", to: "n-s3-meta", relation: "calibrates" },
    ];

    const first = computeAtlasOrbitalLayout(nodes, edges);
    const second = computeAtlasOrbitalLayout([...nodes].reverse(), [...edges].reverse());

    expect(first.width).toBe(720);
    expect(first.height).toBe(520);
    expect(first.positionedNodes.map((n: any) => ({ id: n.id, x: n.x, y: n.y }))).toEqual(
      second.positionedNodes.map((n: any) => ({ id: n.id, x: n.x, y: n.y })),
    );

    for (const node of first.positionedNodes as Array<{ id: string; stratum: keyof typeof STRATUM_RADIUS; x: number; y: number }>) {
      const dist = Math.hypot(node.x - ATLAS_CX, node.y - ATLAS_CY);
      expect(Math.abs(dist - STRATUM_RADIUS[node.stratum])).toBeLessThan(0.1);
    }

    const relA = first.positionedNodes.find((n: any) => n.id === "n-s1-rel-1");
    const relB = first.positionedNodes.find((n: any) => n.id === "n-s1-rel-2");
    expect(Math.hypot(relA.x - relB.x, relA.y - relB.y)).toBeGreaterThan(20);
    expect(planeGroupOf("relational:duo:andy-gillna")).toBe("relational");
    expect(planeGroupOf("domain_work:repo:sugent")).toBe("domain_work");

    expect(first.positionedEdges.find((e: any) => e.id === "e1")?.kind).toBe("membrane");
    expect(first.positionedEdges.find((e: any) => e.id === "e2")?.kind).toBe("superseded");
    expect(first.positionedEdges.find((e: any) => e.id === "e3")?.kind).toBe("active");
  });

  it("keeps full zh-CN and en locale parity for nav, cmd, hub, atlas, and mind sections", () => {
    expect(collectLeafKeys(zhSteward as Record<string, unknown>)).toEqual(
      collectLeafKeys(enSteward as Record<string, unknown>),
    );
    expect(zhSteward.nav.atlas).toBeTruthy();
    expect(enSteward.nav.atlas).toBeTruthy();
    expect(zhSteward.atlas.planes.self_core).toBeTruthy();
    expect(zhSteward.mind.title).toBeTruthy();
  });

  it("uses native dialog with closedby=any, showModal, light-dismiss fallback, and semantic CSS tokens", () => {
    const wbSrc = fs.readFileSync(path.join(ROOT, "ui", "components", "jarvis-workbench.js"), "utf8");
    const atlasSrc = fs.readFileSync(path.join(ROOT, "ui", "components", "memory-atlas-view.js"), "utf8");
    const cssSrc = fs.readFileSync(path.join(ROOT, "ui", "css", "sugent.css"), "utf8");

    expect(wbSrc).toContain('closedby="any"');
    expect(wbSrc).toContain('class="sg-mind-dialog"');
    expect(wbSrc).toContain('aria-labelledby="sg-mind-dialog-title"');
    expect(wbSrc).toContain("showModal");
    expect(wbSrc).toContain('returnValue = ""');
    expect(wbSrc).toContain("closedBy");
    expect(wbSrc).toContain("getBoundingClientRect()");
    expect(wbSrc).not.toContain('role="dialog"');
    expect(wbSrc).not.toContain("aria-modal");
    expect(wbSrc).toContain("/steward/mind-journal");
    expect(wbSrc).toContain("/steward/mind-journal/reconcile");
    expect(wbSrc).toContain("wb?.loyalDissent");
    expect(wbSrc).toContain("wb?.duoSummary");
    expect(wbSrc).toContain("wb.atlasStats.activeNodes ?? wb.atlasStats.totalNodes");
    expect(wbSrc).toContain("wb.atlasStats.activeEdges ?? wb.atlasStats.totalEdges");

    expect(atlasSrc).toContain("/steward/atlas?");
    expect(atlasSrc).toContain("includeGraph");
    expect(atlasSrc).toContain("/steward/atlas/mutate");
    expect(atlasSrc).toContain("promote_stratum");
    expect(atlasSrc).toContain("supersede_node");
    expect(atlasSrc).toContain("tombstone_node");

    expect(cssSrc).toContain("dialog.sg-mind-dialog[open]");
    expect(cssSrc).toContain("dialog.sg-mind-dialog:modal");
    expect(cssSrc).toContain("dialog.sg-mind-dialog::backdrop");
    expect(cssSrc).toContain("overscroll-behavior: contain");
  });
});
