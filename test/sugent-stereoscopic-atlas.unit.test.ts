import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SugentKnowledgeGraph } from "../src/sugent/knowledge-graph.js";
import { AtlasError, StereoscopicAtlas } from "../src/sugent/stereoscopic-atlas.js";

const tempDirs: string[] = [];
const openAtlases: StereoscopicAtlas[] = [];

function makeTempDir(prefix = "sugent-atlas-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (openAtlases.length > 0) {
    openAtlases.pop()?.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("StereoscopicAtlas (Wave P4.2)", () => {
  it("supports all 5 orthogonal planes, 4 epistemic strata, and plane/stratum recall filters", () => {
    const atlas = new StereoscopicAtlas(":memory:");
    openAtlases.push(atlas);

    atlas.applyDelta(
      {
        nodes: [
          {
            id: "self:charter",
            plane: "self_core",
            stratum: "crystallized_wisdom",
            kind: "concept",
            name: "Silicon Charter",
            summary: "克制诚实、忠诚但不盲从的硅基个体宪章",
            tags: ["charter", "identity"],
            reinforcements: 4,
          },
          {
            id: "goal:northstar",
            plane: "owner_life",
            stratum: "verified_fact",
            kind: "project",
            name: "OPC Northstar",
            summary: "主理人北极星目标：聚焦核心产品现金流",
            tags: ["northstar"],
          },
          {
            id: "duo:andy-gillna:crystal",
            plane: "relational:duo-andy-gillna",
            stratum: "crystallized_wisdom",
            kind: "concept",
            name: "Quiet Friday Window",
            summary: "周五晚共处留白窗不安排高负荷工作",
            tags: ["friday", "ritual"],
          },
          {
            id: "proj:sugent:canon",
            plane: "domain_work:sugent",
            stratum: "digested_state",
            kind: "canon",
            name: "Zero-Invasion Adapter Canon",
            summary: "Sugent 自研代码放 src/sugent，避免入侵上游目录",
            tags: ["architecture"],
          },
          {
            id: "sim:routing:ep1",
            plane: "meta_evolution",
            stratum: "raw_episodic",
            kind: "hypothesis",
            name: "Routing Raw Trace",
            summary: "单次路由实验原始日志记录",
            tags: ["trace"],
          },
        ],
      },
      "2026-11-28T10:00:00.000Z",
    );

    const summary = atlas.getPlaneSummary();
    expect(summary.activeNodes).toBe(5);
    expect(Object.keys(summary.byPlane)).toHaveLength(5);
    expect(summary.byStratum.crystallized_wisdom).toBe(2);
    expect(summary.byStratum.verified_fact).toBe(1);
    expect(summary.byStratum.digested_state).toBe(1);
    expect(summary.byStratum.raw_episodic).toBe(1);

    const highStrata = atlas.recallStereoscopic("", { minStratum: "digested_state" });
    expect(highStrata.nodes.map((n) => n.id)).not.toContain("sim:routing:ep1");
    expect(highStrata.nodes.map((n) => n.id)).not.toContain("goal:northstar");

    const selfOnly = atlas.recallStereoscopic("宪章", { planes: ["self_core"] });
    expect(selfOnly.nodes.map((n) => n.id)).toEqual(["self:charter"]);
    expect(selfOnly.markdown).toContain("[self_core | crystallized_wisdom]");
  });

  it("rejects secrets (ATLAS_SECRET_REJECTED) and blocks raw_episodic membrane edges (ATLAS_RAW_MEMBRANE_FORBIDDEN)", () => {
    const atlas = new StereoscopicAtlas(":memory:");
    openAtlases.push(atlas);

    expect(() =>
      atlas.applyDelta({
        nodes: [
          {
            id: "mem:leak",
            plane: "owner_life",
            stratum: "verified_fact",
            kind: "concept",
            name: "Leaked Token",
            summary: "sk-proj-abcdefghijklmnopqrstuvwxyz123456",
          },
        ],
      }),
    ).toThrowError(AtlasError);
    try {
      atlas.applyDelta({
        nodes: [
          {
            id: "mem:leak2",
            plane: "owner_life",
            stratum: "verified_fact",
            kind: "concept",
            name: "Bad",
            summary: "我的密码是 superSecretPass999",
          },
        ],
      });
    } catch (err) {
      expect((err as AtlasError).code).toBe("ATLAS_SECRET_REJECTED");
    }
    expect(atlas.allNodes()).toHaveLength(0);

    atlas.applyDelta({
      nodes: [
        {
          id: "raw:venting",
          plane: "owner_life",
          stratum: "raw_episodic",
          kind: "concept",
          name: "Raw Vent",
          summary: "临时情绪原文片段",
        },
        {
          id: "duo:space:shared",
          plane: "relational:duo-andy-gillna",
          stratum: "digested_state",
          kind: "capsule",
          name: "Shared Space",
          summary: "双人共享状态锚点",
        },
      ],
    });

    expect(() =>
      atlas.applyDelta({
        edges: [
          {
            from: "raw:venting",
            relation: "leaks_to",
            to: "duo:space:shared",
            source: "test",
            isMembraneEdge: true,
          },
        ],
      }),
    ).toThrowError(/ATLAS_RAW_MEMBRANE_FORBIDDEN/);

    expect(() =>
      atlas.applyDelta({
        edges: [
          {
            from: "duo:space:shared",
            relation: "references_raw",
            to: "raw:venting",
            source: "test",
          },
        ],
      }),
    ).toThrowError(/ATLAS_RAW_MEMBRANE_FORBIDDEN/);
  });

  it("enforces symmetric principal ACL isolation for partner:W against owner:M", () => {
    const atlas = new StereoscopicAtlas(":memory:");
    openAtlases.push(atlas);

    atlas.applyDelta({
      nodes: [
        {
          id: "duo:shared:anchor",
          plane: "relational:duo-andy-gillna",
          stratum: "crystallized_wisdom",
          kind: "concept",
          name: "Duo Anchor",
          summary: "Andy 与 Gillna 的共享关系锚点",
          principalAcl: ["sugent_self", "owner:M", "partner:W"],
        },
        {
          id: "pocket:W_private",
          plane: "relational:duo-andy-gillna",
          stratum: "digested_state",
          kind: "concept",
          name: "Gillna Private Pocket",
          summary: "Gillna 尚未公开的私人情绪草稿与界限思考",
          principalAcl: ["partner:W"],
        },
      ],
      edges: [
        {
          from: "duo:shared:anchor",
          relation: "has_private_pocket",
          to: "pocket:W_private",
          source: "duo",
          principalAcl: ["partner:W"],
        },
      ],
    });

    const ownerDefaultRecall = atlas.recallStereoscopic("Gillna Private Pocket");
    expect(ownerDefaultRecall.nodes.map((n) => n.id)).not.toContain("pocket:W_private");

    const ownerExplicitRecall = atlas.recallStereoscopic("", { callerPrincipals: ["owner:M", "sugent_self"] });
    expect(ownerExplicitRecall.nodes.map((n) => n.id)).toEqual(["duo:shared:anchor"]);
    expect(ownerExplicitRecall.edges).toHaveLength(0);

    const partnerRecall = atlas.recallStereoscopic("私人情绪草稿", { callerPrincipals: ["partner:W"] });
    expect(partnerRecall.nodes.map((n) => n.id)).toContain("pocket:W_private");
    expect(partnerRecall.nodes.map((n) => n.id)).toContain("duo:shared:anchor");
  });

  it("performs dual node+edge temporal superseding with zero zombie recall", () => {
    const atlas = new StereoscopicAtlas(":memory:");
    openAtlases.push(atlas);

    atlas.applyDelta(
      {
        nodes: [
          {
            id: "proj:sugent",
            plane: "domain_work:sugent",
            stratum: "verified_fact",
            kind: "project",
            name: "Sugent",
            summary: "个人自治智能体工作台",
          },
          {
            id: "model:sonnet",
            plane: "domain_work:sugent",
            stratum: "verified_fact",
            kind: "tool",
            name: "Claude Sonnet 4.5",
            summary: "旧版主力编码模型 Sonnet",
          },
          {
            id: "model:opus",
            plane: "domain_work:sugent",
            stratum: "verified_fact",
            kind: "tool",
            name: "Claude Opus 4.6",
            summary: "新版主力架构编码模型 Opus",
          },
        ],
        edges: [
          { from: "proj:sugent", relation: "prefers_executor", to: "model:sonnet", source: "day1", exclusive: true },
        ],
      },
      "2026-11-28T09:00:00.000Z",
    );

    const res = atlas.applyDelta(
      {
        edges: [
          { from: "proj:sugent", relation: "prefers_executor", to: "model:opus", source: "day2", exclusive: true },
        ],
      },
      "2026-11-28T10:00:00.000Z",
    );
    expect(res.supersededEdges).toBe(1);
    expect(res.supersededNodes).toBe(1);

    const oldNode = atlas.getNode("model:sonnet");
    expect(oldNode?.supersededAt).toBe("2026-11-28T10:00:00.000Z");
    expect(oldNode?.supersededBy).toBe("model:opus");

    const zombieRecall = atlas.recallStereoscopic("Sonnet");
    expect(zombieRecall.nodes).toHaveLength(0);

    const activeRecall = atlas.recallStereoscopic("Sugent");
    expect(activeRecall.nodes.map((n) => n.id)).toContain("model:opus");
    expect(activeRecall.nodes.map((n) => n.id)).not.toContain("model:sonnet");

    const historyRecall = atlas.recallStereoscopic("Sonnet", { includeSuperseded: true });
    expect(historyRecall.nodes.map((n) => n.id)).toContain("model:sonnet");
  });

  it("ranks hybrid CJK+English recall by BM25 x stratum x reinforcement and traverses membrane bridges", () => {
    const atlas = new StereoscopicAtlas(":memory:");
    openAtlases.push(atlas);

    atlas.applyDelta({
      nodes: [
        {
          id: "raw:sleep",
          plane: "owner_life",
          stratum: "raw_episodic",
          kind: "concept",
          name: "昨晚睡眠",
          summary: "昨晚熬夜调试网关，睡眠不足",
          tags: ["sleep"],
          reinforcements: 1,
        },
        {
          id: "wisdom:recovery",
          plane: "self_core",
          stratum: "crystallized_wisdom",
          kind: "concept",
          name: "睡眠恢复与共处原则",
          summary: "睡眠不足高负荷期应当启动静默恢复，避免强行复盘",
          tags: ["sleep", "recovery"],
          reinforcements: 5,
        },
        {
          id: "duo:weather",
          plane: "relational:duo-andy-gillna",
          stratum: "digested_state",
          kind: "capsule",
          name: "Partner Weather Capsule",
          summary: "今日处于静默降噪恢复模式",
          tags: ["capsule"],
          principalAcl: ["sugent_self", "owner:M", "partner:W"],
        },
      ],
      edges: [
        {
          from: "wisdom:recovery",
          relation: "projects_weather",
          to: "duo:weather",
          source: "membrane:M1",
          isMembraneEdge: true,
          membranePolicy: "M1_delexicalized",
        },
      ],
    });

    const ranked = atlas.recallStereoscopic("睡眠不足 恢复", { maxHops: 2, maxNodes: 10 });
    expect(ranked.nodes[0]?.id).toBe("wisdom:recovery");
    expect(ranked.nodes.map((n) => n.id)).toContain("duo:weather");
    expect(ranked.crossPlaneBridges).toHaveLength(1);
    expect(ranked.markdown).toContain("[membrane:M1_delexicalized]");
  });

  it("enforces maxNodes cap on empty query and persists SQLite + 0o600 JSON snapshot across reloads", () => {
    const dir = makeTempDir();
    const atlas1 = new StereoscopicAtlas(dir);
    atlas1.applyDelta({
      nodes: Array.from({ length: 8 }, (_, idx) => ({
        id: `goal:item-${idx}`,
        plane: "owner_life" as const,
        stratum: "verified_fact" as const,
        kind: "concept",
        name: `Goal ${idx}`,
        summary: `Target milestone number ${idx}`,
        reinforcements: idx,
      })),
    });

    const capped = atlas1.recallStereoscopic("", { maxNodes: 3 });
    expect(capped.nodes).toHaveLength(3);
    expect(capped.nodes[0]?.id).toBe("goal:item-7");
    atlas1.close();

    const dbFile = path.join(dir, "atlas.db");
    const snapFile = path.join(dir, "atlas-snapshot.json");
    expect(fs.existsSync(dbFile)).toBe(true);
    expect(fs.existsSync(snapFile)).toBe(true);
    expect(fs.statSync(dbFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(snapFile).mode & 0o777).toBe(0o600);

    const atlas2 = new StereoscopicAtlas(dir);
    openAtlases.push(atlas2);
    expect(atlas2.allNodes()).toHaveLength(8);
    expect(atlas2.recallStereoscopic("milestone 5").nodes.map((n) => n.id)).toContain("goal:item-5");
  });

  it("imports legacy SugentKnowledgeGraph and classifies legacy prefixes across the 5 planes", () => {
    const kgDir = makeTempDir("sugent-legacy-kg-");
    const kg = new SugentKnowledgeGraph(kgDir);
    kg.applyDelta(
      {
        nodes: [
          { id: "self:voice", kind: "preference", name: "Voice", summary: "简洁克制表达", tags: ["style"] },
          { id: "goal:arr", kind: "concept", name: "ARR", summary: "达成个人商业化目标", tags: ["opc"] },
          { id: "duo:andy-gillna", kind: "person", name: "Duo Space", summary: "伴侣共治空间", tags: ["duo"] },
          { id: "proj:sugent", kind: "project", name: "Sugent", summary: "主力工作台项目", tags: ["repo"] },
          { id: "wf:release", kind: "workflow", name: "Release SOP", summary: "发布门禁流程", tags: ["ci"], reinforcements: 3, steps: ["npm run verify:sugent"] },
          { id: "model:old", kind: "tool", name: "Old Model", summary: "Legacy deprecated model", tags: ["llm"] },
          { id: "model:new", kind: "tool", name: "New Model", summary: "Active preferred model", tags: ["llm"] },
        ],
        edges: [
          { from: "proj:sugent", relation: "prefers_model", to: "model:old", source: "day1", exclusive: true },
          { from: "proj:sugent", relation: "prefers_model", to: "model:new", source: "day2", exclusive: true },
        ],
      },
      "2026-11-28T08:00:00.000Z",
    );

    const atlas = new StereoscopicAtlas(":memory:");
    openAtlases.push(atlas);
    const imported = atlas.importFromLegacyKnowledgeGraph(kg, "2026-11-28T11:00:00.000Z");
    expect(imported.importedNodes).toBe(7);
    expect(imported.importedEdges).toBe(2);

    expect(atlas.getNode("self:voice")?.plane).toBe("self_core");
    expect(atlas.getNode("goal:arr")?.plane).toBe("owner_life");
    expect(atlas.getNode("duo:andy-gillna")?.plane).toBe("relational:duo:andy-gillna");
    expect(atlas.getNode("proj:sugent")?.plane).toBe("domain_work:sugent");
    expect(atlas.getNode("wf:release")?.plane).toBe("meta_evolution");
    expect(atlas.getNode("wf:release")?.stratum).toBe("crystallized_wisdom");
    expect(atlas.getNode("model:old")?.supersededAt).toBeTruthy();
    expect(atlas.recallStereoscopic("deprecated").nodes).toHaveLength(0);
  });
});
